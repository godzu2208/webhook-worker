/**
 * Cloudflare Worker - webhook-worker
 * GỘP 2 HỆ THỐNG trong cùng 1 project:
 *
 *   Hệ thống B (không đổi): Zalo -> "/" (POST/GET) -> Sheets API -> Zalo
 *   Hệ thống A (MỚI):       Frontend (Cloudflare Pages) -> "/api/*" -> Sheets API
 *
 * Cả 2 hệ thống DÙNG CHUNG 1 Service Account / access-token cache đã có
 * sẵn bên dưới (getAccessToken, sheetsBatchGet...) - Hệ thống A không
 * gọi GAS nữa, không cần Apps Script project riêng.
 *
 * Route "/" (webhook cũ): giữ nguyên 100% logic, không CORS (server gọi
 * server từ Zalo Bot Studio, không phải trình duyệt).
 * Route "/api/*" (dashboard mới): có CORS, có session token, có rate
 * limit riêng - tách biệt hoàn toàn khỏi luồng webhook để không ảnh
 * hưởng độ trễ <4s bắt buộc cho Zalo.
 *
 * SECRET/VAR CẦN THÊM (ngoài GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY /
 * SPREADSHEET_ID đã có sẵn):
 *   wrangler secret put SESSION_SECRET     (chuỗi ngẫu nhiên dài)
 *   wrangler secret put FRONTEND_ORIGIN    (VD: https://dashboard.yourdomain.com)
 *   KV namespace binding: DASHBOARD_KV     (rate limit + cache đọc DATA)
 *
 * SHEET CẦN THÊM: tab NHANVIEN (A=Mã NV | B=Họ tên | C=SĐT | D=Vai trò)
 */

// ==== CONFIG (giữ nguyên phần cũ, thêm STAFF_SHEET) ====
const PRODUCT_SHEET = "PRODUCT"; // không dùng trong logic - giữ lại để tham khảo
const DATA_SHEET = "DATA";
const PRICELIST_SHEET = "PRICELIST";
const STAFF_SHEET = "NHANVIEN"; // MỚI - cho Hệ thống A

// Cột trong DATA (đúng theo thứ tự Hệ thống B đang ghi):
// A=ngày kích hoạt | B=user_id | C=phone khách | D=mã bảo hành
// E=mã SP | F=mã NV | G=trạng thái
const DATA_COL = {
  DATE: 0,
  USER_ID: 1,
  PHONE: 2,
  WARRANTY: 3,
  PRODUCT: 4,
  STAFF: 5,
  STATUS: 6,
};

const WARRANTY_CODE_REGEX = /^([A-Z]\d{2})-([A-Z]\d{3})$/;
const SHEETS_TIMEOUT_MS = 2500;

const PROCESSING_MESSAGE =
  "⏳ Yêu cầu của Quý khách đang được xử lý, vui lòng đợi trong giây lát rồi kiểm tra lại " +
  "hoặc liên hệ nhân viên nếu không thấy phản hồi sau ít phút.";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h - cho Hệ thống A
const DATA_CACHE_TTL_SEC = 300; // 5 phút - cache đọc DATA cho dashboard, đủ mới mà đỡ tốn quota Sheets API
const encoder = new TextEncoder();

let cachedToken = null; // { accessToken, expiresAt } - dùng chung cho cả 2 hệ thống

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

      // ==== MỚI: mọi request /api/* thuộc Hệ thống A - tách nhánh riêng ====
      if (url.pathname.startsWith("/api/")) {
        return await routeDashboard_(request, env, url);
      }

      // ==== Từ đây trở xuống: webhook Hệ thống B - KHÔNG đổi ====
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
 * ========== HỆ THỐNG A - DASHBOARD (/api/*) MỚI ==========
 *************************************************/

async function routeDashboard_(request, env, url) {
  if (request.method === "OPTIONS") {
    return corsResponse_(new Response(null, { status: 204 }), env);
  }

  try {
    if (url.pathname === "/api/login" && request.method === "POST") {
      return await handleLogin_(request, env);
    }
    if (url.pathname === "/api/dashboard/period" && request.method === "GET") {
      return await handleAuthed_(request, env, url, async (session, q) => {
        const rows = await getDataRows_(env, q.from, q.to);
        return { ok: true, data: aggByPeriod_(rows, q.groupBy) };
      });
    }
    if (
      url.pathname === "/api/dashboard/staff-product" &&
      request.method === "GET"
    ) {
      return await handleAuthed_(request, env, url, async (session, q) => {
        const rows = await getDataRows_(env, q.from, q.to);
        const maNV =
          session.vaiTro === "nhanvien" ? session.maNV : q.maNV || "";
        return { ok: true, data: aggByStaffProduct_(rows, maNV) };
      });
    }
    if (
      url.pathname === "/api/dashboard/my-sales" &&
      request.method === "GET"
    ) {
      return await handleAuthed_(request, env, url, async (session, q) => {
        const rows = await getDataRows_(env, q.from, q.to);
        const mine = rows.filter((r) => r[DATA_COL.STAFF] === session.maNV);
        return { ok: true, data: { total: mine.length } };
      });
    }
    return corsResponse_(json_({ ok: false, error: "not found" }, 404), env);
  } catch (err) {
    return corsResponse_(
      json_({ ok: false, error: String(err.message || err) }, 500),
      env,
    );
  }
}

// ---------- Login (định danh mã NV + SĐT, không phải auth thật) ----------

async function handleLogin_(request, env) {
  const body = await request.json();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const allowed = await checkRateLimit_(env, "login_" + ip, 10, 600); // 10 lần / 10 phút / IP
  if (!allowed) {
    return corsResponse_(
      json_(
        {
          ok: false,
          message: "Bạn thử quá nhiều lần, vui lòng thử lại sau ít phút.",
        },
        429,
      ),
      env,
    );
  }

  const maNV = String(body.maNV || "").trim();
  const sdt = String(body.sdt || "").trim();
  if (!maNV || !sdt) {
    return corsResponse_(
      json_({ ok: false, message: "Thiếu thông tin." }, 400),
      env,
    );
  }

  const staff = await findStaff_(env, maNV);
  if (!staff || staff.sdt !== normalizeStaffPhone_(sdt)) {
    return corsResponse_(
      json_({ ok: false, message: "Thông tin không đúng." }, 401),
      env,
    );
  }

  const token = await signSession_(env, {
    maNV: staff.maNV,
    vaiTro: staff.vaiTro,
  });
  return corsResponse_(
    json_({
      ok: true,
      hoTen: staff.hoTen,
      maNV: staff.maNV,
      vaiTro: staff.vaiTro,
      token,
    }),
    env,
  );
}

async function findStaff_(env, maNV) {
  const cacheKey = "staff_" + maNV;
  const cached = await env.DASHBOARD_KV.get(cacheKey, "json");
  if (cached) return cached;

  const accessToken = await getAccessToken(env);
  const result = await sheetsGet(
    env.SPREADSHEET_ID,
    accessToken,
    STAFF_SHEET + "!A2:D",
  );
  const rows = result.values || [];
  for (const r of rows) {
    if (String(r[0]).trim() === maNV) {
      const staff = {
        maNV: r[0],
        hoTen: r[1],
        sdt: normalizeStaffPhone_(r[2]),
        vaiTro: r[3] || "nhanvien",
      };
      await env.DASHBOARD_KV.put(cacheKey, JSON.stringify(staff), {
        expirationTtl: 1800,
      }); // 30 phút
      return staff;
    }
  }
  return null;
}

function normalizeStaffPhone_(sdt) {
  return String(sdt)
    .replace(/[^0-9]/g, "")
    .replace(/^84/, "0");
}

// ---------- Đọc DATA (cache 5 phút để đỡ tốn quota Sheets API) ----------

async function getDataRows_(env, fromDate, toDate) {
  const cacheKey = "data_raw";
  let rows;
  const cached = await env.DASHBOARD_KV.get(cacheKey, "json");
  if (cached) {
    rows = cached;
  } else {
    const accessToken = await getAccessToken(env);
    const result = await sheetsGet(
      env.SPREADSHEET_ID,
      accessToken,
      DATA_SHEET + "!A2:G",
    );
    rows = result.values || [];
    await env.DASHBOARD_KV.put(cacheKey, JSON.stringify(rows), {
      expirationTtl: DATA_CACHE_TTL_SEC,
    });
  }

  const from = fromDate ? new Date(fromDate) : null;
  const to = toDate ? new Date(toDate) : null;
  if (to) to.setHours(23, 59, 59, 999);

  return rows.filter((r) => {
    const d = parseVNDateTime_(r[DATA_COL.DATE]);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

// Parse "dd/MM/yyyy HH:mm:ss" (định dạng Hệ thống B đang ghi vào DATA)
function parseVNDateTime_(str) {
  if (!str) return null;
  const m = String(str).match(
    /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/,
  );
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+07:00`);
}

// ---------- Dashboard 1: theo tuần / tháng ----------

function aggByPeriod_(rows, groupBy) {
  const buckets = {};
  rows.forEach((r) => {
    const d = parseVNDateTime_(r[DATA_COL.DATE]);
    if (!d) return;
    const key = groupBy === "week" ? isoWeekKey_(d) : monthKey_(d);
    buckets[key] = (buckets[key] || 0) + 1;
  });
  return Object.entries(buckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, count]) => ({ period, count }));
}

function isoWeekKey_(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

function monthKey_(date) {
  return (
    date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0")
  );
}

// ---------- Dashboard 2: theo NV - theo SP ----------

function aggByStaffProduct_(rows, maNV) {
  const filtered = maNV ? rows.filter((r) => r[DATA_COL.STAFF] === maNV) : rows;
  const buckets = {};
  filtered.forEach((r) => {
    const k = r[DATA_COL.STAFF] + "|" + r[DATA_COL.PRODUCT];
    buckets[k] = buckets[k] || {
      employeeCode: r[DATA_COL.STAFF],
      productCode: r[DATA_COL.PRODUCT],
      count: 0,
    };
    buckets[k].count++;
  });
  return Object.values(buckets).sort((a, b) => b.count - a.count);
}

// ---------- Session token (HMAC, không dùng thư viện ngoài) ----------

async function signSession_(env, payload) {
  const data = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const body = btoa(JSON.stringify(data));
  const sig = await hmac_(env.SESSION_SECRET, body);
  return body + "." + sig;
}

async function verifySession_(env, token) {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expected = await hmac_(env.SESSION_SECRET, body);
  if (expected !== sig) return null;
  try {
    const data = JSON.parse(atob(body));
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function hmac_(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function handleAuthed_(request, env, url, fn) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "");
  const session = await verifySession_(env, token);
  if (!session) {
    return corsResponse_(
      json_(
        {
          ok: false,
          message: "Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.",
        },
        401,
      ),
      env,
    );
  }
  const q = Object.fromEntries(url.searchParams);
  const data = await fn(session, q);
  return corsResponse_(json_(data), env);
}

// ---------- Rate limit (Workers KV) ----------

async function checkRateLimit_(env, key, limit, windowSec) {
  const current = parseInt((await env.DASHBOARD_KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.DASHBOARD_KV.put(key, String(current + 1), {
    expirationTtl: windowSec,
  });
  return true;
}

// ---------- JSON + CORS helpers (chỉ dùng cho /api/*) ----------

function json_(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse_(res, env) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", env.FRONTEND_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers });
}

/*************************************************
 * ========== HỆ THỐNG B - WEBHOOK BẢO HÀNH (không đổi) ==========
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

async function handlePost(rawBody, env) {
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

  const batchGet = await sheetsBatchGet(env.SPREADSHEET_ID, accessToken, [
    DATA_SHEET + "!A2:G",
    PRICELIST_SHEET + "!A2:C",
  ]);

  const valueRanges = batchGet.valueRanges || [];
  const dataRows = (valueRanges[0] && valueRanges[0].values) || [];
  const priceListValues = (valueRanges[1] && valueRanges[1].values) || [];

  const product = findProductInfo(priceListValues, parsed.productCode);

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

  const nextDataRow = dataRows.length + 2;

  const activationDate = new Date();
  const activationDateTimeStr = formatDateTimeVN(activationDate);
  const activationDateStr = activationDateTimeStr.split(" ")[0];

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
 * GOOGLE SHEETS API (dùng chung cho cả 2 hệ thống)
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
 * XÁC THỰC GOOGLE - Service Account JWT -> access token (dùng chung)
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
 * LOGIC NGHIỆP VỤ - webhook (không đổi)
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
 * RESPONSE HELPERS - webhook (không đổi)
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
