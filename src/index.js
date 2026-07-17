/**
 * Cloudflare Worker - Proxy giữa Zalo Dynamic AI / Bot Studio và Google Apps Script Web App
 *
 * Vấn đề gốc:
 *   - Apps Script (ContentService) luôn trả về:
 *       Content-Type: application/json; charset=UTF-8   (Zalo yêu cầu đúng "application/json")
 *       Transfer-Encoding: chunked                       (Zalo yêu cầu Content-Length cố định)
 *   - Apps Script không cho tùy chỉnh 2 header trên -> Zalo từ chối response.
 *
 * Cách xử lý:
 *   - Worker này nhận request từ Zalo (GET hoặc POST)
 *   - Forward nguyên vẹn sang GAS_URL (/exec)
 *   - Đọc hết response body (loại bỏ chunked), rồi trả lại với
 *     Content-Type: application/json (không có charset) và Content-Length chính xác.
 *
 * CẬP NHẬT (fix retry rỗng):
 *   - Quan sát log cho thấy: dù GAS trả lời "Ok" đầy đủ, Zalo vẫn tự
 *     bắn 1 request retry (không kèm body) sau ~3s nếu request gốc
 *     chưa nhận được response ĐỦ NHANH theo ngưỡng chờ nội bộ của
 *     Zalo (không cố định, dao động tùy tải GAS cold-start...).
 *     Không thể triệt tiêu hoàn toàn việc này chỉ bằng tối ưu tốc độ
 *     GAS, vì ngưỡng chờ đó nằm ngoài tầm kiểm soát của mình.
 *   - Giải pháp: Worker luôn đua (Promise.race) giữa việc chờ GAS trả
 *     lời và một timeout nội bộ AN TOÀN (~2.8s, nhỏ hơn ngưỡng ~4s mà
 *     Zalo hay dùng để hủy + retry). Nếu GAS trả lời kịp trong 2.8s ->
 *     trả luôn kết quả thật. Nếu KHÔNG kịp -> chủ động trả một tin
 *     nhắn tạm "đang xử lý" cho Zalo NGAY, thay vì im lặng để Zalo tự
 *     hủy và bắn request rỗng (gây lỗi xấu / trùng lặp).
 *   - Request tới GAS vẫn tiếp tục chạy NGẦM sau khi đã trả response
 *     tạm cho Zalo, nhờ ctx.waitUntil() -> đảm bảo Sheet vẫn được ghi
 *     đầy đủ dù client đã "bỏ đi".
 *
 *   LƯU Ý QUAN TRỌNG (giới hạn của giải pháp này):
 *   Khi rơi vào nhánh timeout, tin nhắn "đang xử lý" là placeholder,
 *   KHÔNG phải kết quả thật (vd: không biết chính xác là kích hoạt
 *   thành công hay lỗi, sản phẩm gì, giá bao nhiêu). GAS xử lý xong ở
 *   background nhưng KHÔNG có cách nào tự đẩy kết quả thật đó ngược
 *   lại cho khách qua chính lượt chat này, vì kết nối gốc đã đóng.
 *   Muốn khách nhận được kết quả thật trong trường hợp timeout, cần
 *   thêm bước gọi Zalo OA Send Message API (chủ động gửi tin) từ phía
 *   GAS sau khi ghi Sheet xong - đây là việc nằm ngoài phạm vi sửa
 *   nhanh này, cần user_id (đã có sẵn trong payload) + access token
 *   của OA để gọi API gửi tin nhắn broadcast/transaction.
 */

const GAS_TIMEOUT_MS = 2800; // nhỏ hơn ngưỡng cancel ~4s của Zalo, có buffer an toàn

const PROCESSING_MESSAGE =
  "⏳ Yêu cầu của Quý khách đang được xử lý, vui lòng đợi trong giây lát rồi kiểm tra lại " +
  "hoặc liên hệ nhân viên nếu không thấy phản hồi sau ít phút.";

export default {
  async fetch(request, env, ctx) {
    const GAS_URL = env.GAS_URL;

    if (!GAS_URL || GAS_URL.includes("REPLACE_WITH_YOUR_DEPLOYMENT_ID")) {
      return jsonError(
        "Worker chưa được cấu hình GAS_URL. Vào Cloudflare Dashboard > Worker > Settings > Variables để cập nhật.",
        500,
      );
    }

    try {
      const url = new URL(request.url);
      let upstreamUrl = GAS_URL;

      // Forward query string (dùng cho doGet, vd ?code=LT000016NV0012)
      if (url.search) {
        upstreamUrl += url.search;
      }

      const init = {
        method: request.method,
        redirect: "follow", // Apps Script luôn 302 redirect sang googleusercontent.com
      };

      let rawBody = "";
      if (request.method === "POST") {
        init.headers = { "Content-Type": "application/json" };
        rawBody = await request.text();
        init.body = rawBody;
      }

      // DEBUG LOG: xem qua `npx wrangler tail` để biết chính xác
      // Zalo gửi gì tới Worker (method, content-type gốc, body thô).
      console.log(
        JSON.stringify({
          debug: "incoming_request",
          method: request.method,
          incoming_content_type: request.headers.get("content-type"),
          body_length: rawBody.length,
          body_preview: rawBody.slice(0, 500),
          query: url.search,
        }),
      );

      // Gọi GAS độc lập với vòng đời response gửi về Zalo: dù mình trả
      // response tạm cho Zalo trước (nhánh timeout bên dưới), promise
      // này vẫn tiếp tục chạy nhờ ctx.waitUntil -> đảm bảo GAS ghi
      // Sheet xong.
      const upstreamPromise = fetch(upstreamUrl, init).then(
        async (upstream) => {
          const text = await upstream.text(); // đọc trọn body -> loại bỏ chunked encoding

          console.log(
            JSON.stringify({
              debug: "upstream_response",
              status: upstream.status,
              body_preview: text.slice(0, 500),
            }),
          );

          return { text, status: upstream.status };
        },
      );

      ctx.waitUntil(
        upstreamPromise.catch((err) => {
          console.error("upstream fetch failed:", err.message);
        }),
      );

      // Đua giữa: (a) GAS trả lời kịp, (b) hết 2.8s vẫn chưa có gì.
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), GAS_TIMEOUT_MS);
      });

      const winner = await Promise.race([upstreamPromise, timeoutPromise]);

      if (winner && winner.timedOut) {
        console.log(
          JSON.stringify({
            debug: "gas_timeout_fallback",
            method: request.method,
            query: url.search,
            note:
              "GAS chưa trả lời trong " +
              GAS_TIMEOUT_MS +
              "ms, trả placeholder cho Zalo. GAS vẫn chạy ngầm.",
          }),
        );
        return buildTimeoutResponse(request.method);
      }

      // GAS trả lời kịp -> trả nguyên kết quả thật
      return jsonResponse(winner.text, winner.status);
    } catch (err) {
      return jsonError("Proxy error: " + err.message, 500);
    }
  },
};

/**
 * Response tạm khi GAS chưa kịp trả lời trong ngưỡng an toàn.
 * - POST (doPost / chatbot) -> đúng schema "version: chatbot" mà Bot
 *   Studio mong đợi, để hiển thị tin nhắn tạm tử tế thay vì lỗi xấu.
 * - GET (doGet / Dynamic AI) -> đúng schema { success, message } mà
 *   doGet vẫn trả, để Dynamic AI không bị crash khi parse.
 */
function buildTimeoutResponse(method) {
  const body =
    method === "POST"
      ? JSON.stringify({
          version: "chatbot",
          content: { messages: [{ type: "text", text: PROCESSING_MESSAGE }] },
        })
      : JSON.stringify({ success: false, message: PROCESSING_MESSAGE });

  return jsonResponse(body, 200);
}

/**
 * Trả JSON response với Content-Type và Content-Length chuẩn (không chunked, không charset)
 */
function jsonResponse(text, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bytes.length),
    },
  });
}

function jsonError(message, status) {
  return jsonResponse(JSON.stringify({ success: false, message }), status);
}
