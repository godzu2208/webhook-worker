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
 * Cập nhật: dùng ctx.waitUntil() để đảm bảo request tới GAS luôn
 * chạy XONG (ghi Sheet xong) dù Zalo có hủy kết nối gốc giữa chừng
 * vì chờ quá lâu (~4s). Nếu không có waitUntil, Cloudflare có thể
 * dừng Worker giữa lúc GAS đang ghi dữ liệu -> mất dữ liệu.
 */

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

      // Gọi GAS độc lập với vòng đời response gửi về Zalo: dù Zalo
      // hủy kết nối, promise này vẫn tiếp tục chạy nhờ ctx.waitUntil
      // bên dưới -> đảm bảo GAS ghi Sheet xong.
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

      const { text, status } = await upstreamPromise;

      return jsonResponse(text, status);
    } catch (err) {
      return jsonError("Proxy error: " + err.message, 500);
    }
  },
};

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
