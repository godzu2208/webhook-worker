/**
 * Cloudflare Worker - Kích hoạt bảo hành cho Zalo Bot Studio / Dynamic AI
 *
 * KIẾN TRÚC (không đổi so với bản trước):
 *   Zalo -> Worker -> sheets.googleapis.com (trực tiếp, Service Account) -> Worker -> Zalo
 *
 * THAY ĐỔI SO VỚI BẢN TRƯỚC (yêu cầu 3 trong phan-tich-kien-truc-du-an.md):
 *   1. Đổi định dạng mã bảo hành:
 *        Cũ:  LT000016NV0012  (2 chữ + 6 số) + (NV + 4 số), viết liền
 *        Mới: S01-M001        (1 chữ + 2 số) - (1 chữ + 3 số), có gạch ngang
 *      -> Độ dài đã CỐ ĐỊNH theo xác nhận của bạn, regex viết chặt theo
 *         đúng số chữ số này (không dùng {2,} linh hoạt nữa).
 *
 *   2. Bỏ hẳn vai trò kiểm soát của sheet PRODUCT:
 *      - Trước: mã phải có sẵn trong PRODUCT mới kích hoạt được; PRODUCT!D:E
 *        được ghi "Đã kích hoạt" + ngày sau khi kích hoạt thành công.
 *      - Giờ: mã do khách/nhân viên tự nhập, không cần có sẵn ở đâu cả.
 *        + Không thấy mã trong DATA (cột D) -> hợp lệ, đây là lần kích
 *          hoạt đầu tiên -> cho kích hoạt.
 *        + Thấy mã trong DATA rồi -> đã kích hoạt trước đó -> trả thông
 *          tin cũ, không ghi thêm.
 *      - Theo xác nhận của bạn: KHÔNG thêm lớp validate mã nhân viên
 *        (sheet NHANVIEN/STAFF). Lớp chặn duy nhất còn lại là mã SP phải
 *        tồn tại trong PRICELIST. Rủi ro (đã nêu trong tài liệu phân
 *        tích): ai đoán đúng định dạng S0x-Mxxx với mã SP có thật trong
 *        PRICELIST đều kích hoạt được, kể cả chưa từng mua sản phẩm đó.
 *      - Round-trip #2 giờ chỉ còn 1 lệnh ghi (vào DATA), bỏ hẳn lệnh ghi
 *        thứ 2 vào PRODUCT -> nhanh hơn bản cũ.
 *
 *   PRODUCT_SHEET vẫn giữ trong CONFIG để không vỡ nếu bạn còn tham chiếu
 *   sheet này ở nơi khác, nhưng KHÔNG còn được đọc/ghi trong luồng xử lý.
 *
 * YÊU CẦU THIẾT LẬP (không đổi):
 *   1. Tạo Service Account trên Google Cloud, bật Google Sheets API.
 *   2. Share Google Sheet (Editor) cho email của Service Account.
 *   3. Set 2 secret trên Cloudflare: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY.
 *   4. Set var SPREADSHEET_ID trong wrangler.toml.
 */

// ==== CONFIG ====
const PRODUCT_SHEET = "PRODUCT"; // KHÔNG còn dùng trong logic - giữ lại tên sheet để tham khảo/tra cứu thủ công nếu cần.
const DATA_SHEET = "DATA";
const PRICELIST_SHEET = "PRICELIST";

// Định dạng mã bảo hành MỚI: <MaSP>-<MaNV>
// Ví dụ: S01-M001 -> Mã SP = S01, Mã NV = M001
// Mã SP: 1 chữ cái + 2 số  |  Mã NV: 1 chữ cái + 3 số  | nối bằng "-"
const WARRANTY_CODE_REGEX = /^([A-Z]\d{2})-([A-Z]\d{3})$/;

// Timeout an toàn cho toàn bộ luồng xử lý (gọi Google Sheets API + logic).
const SHEETS_TIMEOUT_MS = 2500;

const PROCESSING_MESSAGE =
  "⏳ Yêu cầu của Quý khách đang được xử lý, vui lòng đợi trong giây lát rồi kiểm tra lại " +
  "hoặc liên hệ nhân viên nếu không thấy phản hồi sau ít phút.";

// Cache access token trong bộ nhớ isolate.
let cachedToken = null; // { accessToken, expiresAt }

export default {
  async fetch(request, env, ctx) {
    try {
      if (
        !env.SPREADSHEET_ID ||
        !env.GOOGLE_CLIENT_EMAIL ||
        !env.GOOGLE_PRIVATE_KEY
      ) {
        return jsonError(
          "Worker chưa được cấu hình đủ SPREADSHEET_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY.",
          500,
        );
      }

      const url = new URL(request.url);

      let rawBody = "";
      if (request.method === "POST") {
        rawBody = await request.text();
      }

      console.log(
        JSON.stringify({
          debug: "incoming_request",
          method: request.method,
          body_length: rawBody.length,
          body_preview: rawBody.slice(0, 500),
          query: url.search,
        }),
      );

      const workPromise = handleRequest(request.method, rawBody, url, env);

      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), SHEETS_TIMEOUT_MS);
      });

      const winner = await Promise.race([
        workPromise.then((r) => ({ ...r, timedOut: false })),
        timeoutPromise,
      ]);

      if (winner.timedOut) {
        console.log(
          JSON.stringify({
            debug: "sheets_timeout_fallback",
            method: request.method,
            query: url.search,
          }),
        );
        ctx.waitUntil(
          workPromise.catch((err) => {
            console.error("background work failed:", err.message);
          }),
        );
        return buildTimeoutResponse(request.method);
      }

      console.log(
        JSON.stringify({
          debug: "response",
          status: winner.status,
          body_preview: winner.body.slice(0, 500),
        }),
      );

      return jsonResponse(winner.body, winner.status || 200);
    } catch (err) {
      console.error("fetch handler error:", err.stack || err.message);
      return jsonError("Lỗi hệ thống: " + err.message, 500);
    }
  },
};

/*************************************************
 * ĐIỀU HƯỚNG THEO METHOD
 *************************************************/

async function handleRequest(method, rawBody, url, env) {
  if (method === "POST") {
    return await handlePost(rawBody, env);
  }
  if (method === "GET") {
    return await handleGet(url, env);
  }
  return {
    body: JSON.stringify({
      success: false,
      message: "Method không được hỗ trợ.",
    }),
    status: 405,
  };
}

/*************************************************
 * POST - Ghi nhận kích hoạt bảo hành
 *
 * LOGIC MỚI (yêu cầu 3):
 *   - Không còn đọc/ghi PRODUCT.
 *   - Đọc DATA!A2:G để: (a) tìm xem mã đã kích hoạt trước đó chưa
 *     (đối chiếu cột D - warrantyCode), (b) tính dòng trống tiếp theo.
 *   - Không tìm thấy mã trong DATA + mã SP có trong PRICELIST -> cho
 *     kích hoạt (ghi 1 dòng mới vào DATA).
 *   - Tìm thấy mã trong DATA rồi -> trả thông tin đã kích hoạt trước đó,
 *     không ghi thêm.
 *************************************************/

async function handlePost(rawBody, env) {
  // Phòng thủ: request retry của Zalo không kèm body.
  if (!rawBody) {
    return {
      body: chatbotMessage(
        "❌ Lỗi hệ thống: request không có dữ liệu (body trống). " +
          "Đây thường là do request trước bị timeout, vui lòng thử lại.",
      ),
      status: 200,
    };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return {
      body: chatbotMessage(
        "❌ Lỗi hệ thống: dữ liệu gửi lên không phải JSON hợp lệ.",
      ),
      status: 200,
    };
  }

  const unresolvedFields = findUnresolvedFields(payload, [
    "display_name",
    "user_id",
    "phone",
    "ma_bao_hanh",
  ]);

  if (unresolvedFields.length > 0) {
    return {
      body: chatbotMessage(
        "❌ Lỗi cấu hình Zalo: biến " +
          unresolvedFields.join(", ") +
          " chưa được thay giá trị thật (vẫn còn dạng {{...}}). " +
          "Vui lòng kiểm tra lại mapping biến ở bước gửi request trong Bot Studio.",
      ),
      status: 200,
    };
  }

  const displayName = payload.display_name || "";
  const userId = payload.user_id || "";
  const rawPhone = payload.phone || "";
  const warrantyCode = (payload.ma_bao_hanh || "").trim().toUpperCase();

  if (!isValidPhone(rawPhone)) {
    return {
      body: chatbotMessage("❌ Số điện thoại không đúng định dạng."),
      status: 200,
    };
  }

  const phone = normalizePhone(rawPhone);

  const parsed = parseWarrantyCode(warrantyCode);
  if (!parsed) {
    return {
      body: chatbotMessage("❌ Mã bảo hành không đúng định dạng."),
      status: 200,
    };
  }

  const accessToken = await getAccessToken(env);

  // ROUND-TRIP #1: đọc DATA (để check trùng mã + tính dòng trống tiếp
  // theo) và PRICELIST (lấy tên/giá SP) CÙNG LÚC trong 1 batchGet.
  // Đọc A2:G (bỏ header) - so với bản cũ đọc "A:A", giờ cần đọc đủ cột
  // để lấy được warrantyCode (cột D) và ngày kích hoạt (cột A) khi so
  // trùng.
  const batchGet = await sheetsBatchGet(env.SPREADSHEET_ID, accessToken, [
    DATA_SHEET + "!A2:G",
    PRICELIST_SHEET + "!A2:C",
  ]);

  const valueRanges = batchGet.valueRanges || [];
  const dataRows = (valueRanges[0] && valueRanges[0].values) || [];
  const priceListValues = (valueRanges[1] && valueRanges[1].values) || [];

  const product = findProductInfo(priceListValues, parsed.productCode);

  // Check trùng: tìm mã bảo hành trong cột D của DATA (index 3).
  const existingRow = dataRows.find((r) => r[3] === warrantyCode);

  if (existingRow) {
    const existingDate = formatDateValue(existingRow[0]).split(" ")[0];
    return {
      body: chatbotMessage(
        buildInfoMessage(
          "already_activated",
          displayName,
          rawPhone,
          warrantyCode,
          product,
          existingDate,
        ),
      ),
      status: 200,
    };
  }

  // Chặn kích hoạt nếu PRICELIST chưa có sản phẩm tương ứng - đây là
  // lớp chặn duy nhất còn lại sau khi bỏ PRODUCT (theo xác nhận của bạn,
  // không thêm validate mã nhân viên).
  if (!product) {
    return {
      body: chatbotMessage(
        "❌ Không tìm thấy thông tin sản phẩm cho mã: " +
          parsed.productCode +
          " trong bảng giá (PRICELIST). Vui lòng bổ sung sản phẩm vào PRICELIST " +
          "rồi yêu cầu khách quét lại mã bảo hành, KHÔNG được kích hoạt khi thiếu giá.",
      ),
      status: 200,
    };
  }

  // dataRows đọc từ A2 (không có header) -> dòng trống tiếp theo
  // = số dòng dữ liệu hiện có + 2 (1 cho header, 1 để trỏ tới dòng kế tiếp).
  const nextDataRow = dataRows.length + 2;

  const activationDate = new Date();
  const activationDateTimeStr = formatDateTimeVN(activationDate);
  const activationDateStr = activationDateTimeStr.split(" ")[0];

  // ROUND-TRIP #2: CHỈ còn ghi 1 dòng mới vào DATA - đã bỏ hẳn lệnh ghi
  // thứ 2 vào PRODUCT!D:E vì PRODUCT không còn vai trò gì trong luồng
  // này nữa.
  await sheetsBatchUpdate(env.SPREADSHEET_ID, accessToken, [
    {
      range: DATA_SHEET + "!A" + nextDataRow,
      values: [
        [
          activationDateTimeStr,
          userId,
          phone,
          warrantyCode,
          parsed.productCode,
          parsed.employeeCode,
          "Đã kích hoạt",
        ],
      ],
    },
  ]);

  return {
    body: chatbotMessage(
      buildInfoMessage(
        "success",
        displayName,
        rawPhone,
        warrantyCode,
        product,
        activationDateStr,
      ),
    ),
    status: 200,
  };
}

/*************************************************
 * GET - Tra cứu thông tin sản phẩm theo mã bảo hành
 * Dùng cho Dynamic AI: GET https://.../?code=S01-M001
 * (không đổi logic, chỉ đổi format mã qua parseWarrantyCode/regex mới)
 *************************************************/

async function handleGet(url, env) {
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (hasUnresolvedTemplate(code)) {
    return {
      body: JSON.stringify({
        success: false,
        message:
          "Lỗi cấu hình Zalo: tham số code chưa được thay giá trị thật (" +
          code +
          ").",
      }),
      status: 200,
    };
  }

  if (!code) {
    return {
      body: JSON.stringify({
        success: false,
        message: "Thiếu tham số code. Dùng dạng: ?code=S01-M001",
      }),
      status: 200,
    };
  }

  const parsed = parseWarrantyCode(code);
  if (!parsed) {
    return {
      body: JSON.stringify({
        success: false,
        message: "Mã bảo hành không đúng định dạng.",
      }),
      status: 200,
    };
  }

  const accessToken = await getAccessToken(env);
  const result = await sheetsGet(
    env.SPREADSHEET_ID,
    accessToken,
    PRICELIST_SHEET + "!A2:C",
  );
  const product = findProductInfo(result.values || [], parsed.productCode);

  if (!product) {
    return {
      body: JSON.stringify({
        success: false,
        message:
          "Không tìm thấy thông tin sản phẩm cho mã: " + parsed.productCode,
      }),
      status: 200,
    };
  }

  return {
    body: JSON.stringify({
      success: true,
      ma_bao_hanh: code,
      product_id: parsed.productCode,
      ma_nhan_vien: parsed.employeeCode,
      product_name: product.name,
      product_price: Number(product.price),
    }),
    status: 200,
  };
}

/*************************************************
 * GOOGLE SHEETS API - gọi trực tiếp bằng access token
 *************************************************/

async function sheetsBatchGet(spreadsheetId, accessToken, ranges) {
  const query = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query}`,
    { headers: { Authorization: "Bearer " + accessToken } },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      "Sheets batchGet lỗi " + res.status + ": " + errText.slice(0, 300),
    );
  }

  return await res.json();
}

async function sheetsGet(spreadsheetId, accessToken, range) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: "Bearer " + accessToken } },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      "Sheets get lỗi " + res.status + ": " + errText.slice(0, 300),
    );
  }

  return await res.json();
}

async function sheetsBatchUpdate(spreadsheetId, accessToken, data) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      "Sheets batchUpdate lỗi " + res.status + ": " + errText.slice(0, 300),
    );
  }

  return await res.json();
}

/*************************************************
 * XÁC THỰC GOOGLE - Service Account JWT -> access token
 *************************************************/

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const jwt = await createServiceAccountJWT(env);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=" +
      encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" +
      encodeURIComponent(jwt),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      "Lấy access token từ Google thất bại " +
        res.status +
        ": " +
        errText.slice(0, 300),
    );
  }

  const data = await res.json();

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 3600),
  };

  return cachedToken.accessToken;
}

async function createServiceAccountJWT(env) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaimSet = base64url(JSON.stringify(claimSet));
  const signingInput = encodedHeader + "." + encodedClaimSet;

  const privateKey = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);

  const signatureBuffer = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  return signingInput + "." + base64urlFromArrayBuffer(signatureBuffer);
}

async function importPrivateKey(pemKey) {
  const pemContents = pemKey
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = base64ToArrayBuffer(pemContents);

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/*************************************************
 * LOGIC NGHIỆP VỤ
 *************************************************/

function buildInfoMessage(
  kind,
  displayName,
  phone,
  warrantyCode,
  product,
  dateStr,
) {
  const productName = product ? product.name : "Không rõ";
  const productPrice = product ? formatCurrencyVN(product.price) : "Không rõ";

  const header =
    kind === "success"
      ? "Gia Tuệ Mobile xin cảm ơn Quý khách đã điền form thông tin. Để chính xác thông tin, khách hàng cần kiểm tra lại thông tin đơn hàng trước khi Kích hoạt bảo hành :"
      : "Quý khách vui lòng kiểm tra lại thông tin đơn hàng, đơn hàng hiện tại đã được Kích hoạt bảo hành";

  return (
    header +
    "\n✅ Họ tên : " +
    displayName +
    "\n✅ SĐT : " +
    phone +
    "\n✅ Mã bảo hành : " +
    warrantyCode +
    "\n✅ Sản phẩm : " +
    productName +
    "\n✅ Giá trị : " +
    productPrice +
    " đ" +
    "\n✅ Ngày kích hoạt : " +
    dateStr
  );
}

function findProductInfo(priceListValues, productCode) {
  for (let i = 0; i < priceListValues.length; i++) {
    if (priceListValues[i][0] == productCode) {
      return { name: priceListValues[i][1], price: priceListValues[i][2] };
    }
  }
  return null;
}

function formatCurrencyVN(number) {
  return Number(number).toLocaleString("vi-VN");
}

// Chuẩn hóa giá trị ngày đọc từ Sheets. Dữ liệu MỚI ghi bởi bản Worker
// này luôn là string "dd/MM/yyyy HH:mm:ss" sẵn nên hàm chỉ việc trả
// nguyên; vẫn giữ khả năng parse phòng dữ liệu cũ còn sót định dạng khác.
function formatDateValue(value) {
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "string") {
    if (/^\d{2}\/\d{2}\/\d{4}/.test(value)) {
      return value;
    }
    const parsedDate = new Date(value);
    if (!isNaN(parsedDate.getTime())) {
      return formatDateTimeVN(parsedDate);
    }
  }

  return String(value);
}

function formatDateTimeVN(date) {
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));

  return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second}`;
}

// Parse mã bảo hành ĐỊNH DẠNG MỚI: S01-M001 -> { productCode: "S01", employeeCode: "M001" }
function parseWarrantyCode(warrantyCode) {
  const match = warrantyCode.match(WARRANTY_CODE_REGEX);
  if (!match) return null;
  return { productCode: match[1], employeeCode: match[2] };
}

function hasUnresolvedTemplate(value) {
  return typeof value === "string" && /\{\{\s*[\w.]+\s*\}\}/.test(value);
}

function findUnresolvedFields(payload, fields) {
  const bad = [];
  fields.forEach((f) => {
    if (hasUnresolvedTemplate(payload[f])) bad.push(f);
  });
  return bad;
}

function isValidPhone(phone) {
  const regex = /^(0|\+?84)(3|5|7|8|9)\d{8}$/;
  return regex.test(phone);
}

function normalizePhone(phone) {
  return phone.replace(/^(\+?84)/, "0");
}

/*************************************************
 * RESPONSE HELPERS
 *************************************************/

function chatbotMessage(text) {
  return JSON.stringify({
    version: "chatbot",
    content: { messages: [{ type: "text", text }] },
  });
}

function buildTimeoutResponse(method) {
  const body =
    method === "POST"
      ? chatbotMessage(PROCESSING_MESSAGE)
      : JSON.stringify({ success: false, message: PROCESSING_MESSAGE });
  return jsonResponse(body, 200);
}

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
