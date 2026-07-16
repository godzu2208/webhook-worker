# zalo-gas-proxy

Cloudflare Worker đóng vai trò **proxy trung gian** giữa Zalo (Bot Studio / Dynamic AI)
và Google Apps Script Web App, để sửa lỗi:

```
ERROR  Invalid request. The 'Content-Type' of response must be equal application/json
ERROR  Invalid request. Responses must set 'Content-Length' and 'Transfer-Encoding' not equal chunked
```

Nguyên nhân: Apps Script luôn trả `Content-Type: application/json; charset=UTF-8` và
`Transfer-Encoding: chunked`, không thể tùy chỉnh — Zalo yêu cầu đúng `application/json`
và `Content-Length` cố định. Worker này forward request sang Apps Script rồi trả lại
response với header đúng chuẩn Zalo yêu cầu.

## 1. Tạo repo trên GitHub

```bash
# Trong thư mục dự án
git init
git add .
git commit -m "init: zalo-gas-proxy worker"
git branch -M main
git remote add origin https://github.com/<username>/zalo-gas-proxy.git
git push -u origin main
```

(Tạo repo trống trước trên https://github.com/new, không tick "Initialize with README")

## 2. Cấu hình GAS_URL

Mở `wrangler.toml`, thay:

```toml
[vars]
GAS_URL = "https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec"
```

bằng URL `/exec` thật của bạn (Deploy > Manage deployments trong Apps Script Editor).

> Lưu ý: mỗi lần bạn **Deploy lại** Apps Script với "New deployment", URL `/exec` sẽ đổi.
> Nếu bạn dùng "Manage deployments > Edit > Version: New version" cho deployment hiện có,
> URL giữ nguyên — nên dùng cách này để không phải sửa `wrangler.toml` liên tục.

## 3. Cài Wrangler & đăng nhập Cloudflare

```bash
npm install
npx wrangler login
```

Lệnh trên mở trình duyệt để bạn đăng nhập/ủy quyền tài khoản Cloudflare (miễn phí).

## 4. Deploy

```bash
npx wrangler deploy
```

Sau khi deploy xong, Wrangler in ra URL dạng:

```
https://zalo-gas-proxy.<your-subdomain>.workers.dev
```

## 5. Cập nhật endpoint trong Zalo Bot Studio

Vào Bot Studio > cấu hình Dynamic Message / bước gọi API kích hoạt bảo hành,
đổi URL đang trỏ tới `script.google.com/.../exec` thành URL Worker ở bước 4.

- Với **doPost** (kích hoạt bảo hành): giữ nguyên phương thức POST, body JSON như cũ.
- Với **doGet** (tra cứu Dynamic AI): gọi `https://<worker-url>?code=LT000016NV0012`
  — Worker sẽ tự forward query string sang Apps Script.

## 6. Test nhanh sau khi deploy

```bash
# Test doGet
curl "https://zalo-gas-proxy.<your-subdomain>.workers.dev?code=LT000016NV0012"

# Test doPost
curl -X POST "https://zalo-gas-proxy.<your-subdomain>.workers.dev" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"123","phone":"0912345678","ma_bao_hanh":"LT000016NV0012"}'
```

Kiểm tra header response phải là:

```
content-type: application/json
content-length: <số>
```

(không có `charset`, không có `transfer-encoding: chunked`)

## Cập nhật GAS_URL sau này mà không deploy lại code

Có thể set biến qua CLI thay vì sửa `wrangler.toml` + deploy:

```bash
npx wrangler secret put GAS_URL
```

(Nếu dùng `wrangler secret`, cần đổi `env.GAS_URL` — code hiện tại đọc từ `[vars]`,
 hai cách đều hoạt động vì Wrangler expose cả hai qua `env`.)
