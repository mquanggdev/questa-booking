# ADR-0013: Kiến trúc ứng dụng web (Next.js 16)

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-08
- Giai đoạn: 6

## Bối cảnh

Giai đoạn 6 thêm trang mua vé tối giản trong `apps/web`: danh sách concert, sơ đồ ghế, chọn vé đứng, thanh toán và vé QR. Đặc tả đã chốt công nghệ: Next.js, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, react-konva; kiểu dữ liệu sinh từ Swagger; test luồng mua vé bằng Playwright.

Có ba ràng buộc định hình thiết kế:

- **Cách API xác thực** ([ADR-0004](0004-authentication.md)):
  - access token trả trong body và sống 15 phút;
  - refresh token nằm trong cookie `httpOnly` có `path=/api/v1/auth`;
  - refresh token **xoay vòng**: dùng lại một token cũ bị coi là bị đánh cắp, và cả "family" bị thu hồi.
- **Next.js 16** (bản mới nhất lúc làm) bật mặc định Cache Components và Partial Prefetching. Theo mô hình này, mọi dữ liệu đọc lúc có request phải nằm trong `<Suspense>`.
- **Cổng thanh toán đưa trình duyệt đi rồi đưa về**, nên các trang thanh toán và trang kết quả phải thuộc web, không phải JSON của API.

## Quyết định

### 1. Một origin duy nhất: web chuyển `/api/*` sang API

`next.config.ts` khai báo `rewrites`: `/api/:path*` → `API_INTERNAL_URL/api/:path*`. Đích là `http://api:3000` trong Docker, `http://localhost:3100` khi phát triển. Trình duyệt chỉ nói chuyện với một origin, nên:

- cookie refresh (`httpOnly`, `SameSite=Strict`, path `/api/v1/auth`) hoạt động như khi chạy sau reverse proxy, không cần CORS hay `SameSite=None`;
- `PUBLIC_BASE_URL` trở thành **origin công khai của cả trang**: web ở `/`, API ở `/api`, IPN ở `/api/v1/payments/ipn/<provider>`.

Khi deploy, một reverse proxy có thể chuyển thẳng `/api` sang API để bỏ một chặng qua Next.js. Code không phải đổi.

### 2. Server Component cho danh mục, Client Component cho phần mua

- **Danh sách concert, chi tiết concert, đầu trang đêm diễn**: Server Component, gọi API qua mạng nội bộ **lúc có request**, bọc trong `<Suspense>`.
  - Không dùng `'use cache'`: số vé còn lại phải luôn mới. Việc cache danh mục là của giai đoạn 7a, ở tầng API.
  - Nhờ vậy `next build` không cần API đang chạy, và image Docker build ở đâu cũng được.
- **Sơ đồ ghế, giữ vé, đơn hàng, thanh toán, vé**: Client Component với TanStack Query, vì cần access token (chỉ có trong trình duyệt) và cần làm mới liên tục. Sơ đồ ghế tải lại mỗi 5 giây; đơn `PENDING` tải lại mỗi 3 giây, vì IPN hay job hết hạn có thể đổi đơn bất kỳ lúc nào. Giai đoạn 7a thay polling bằng WebSocket.

### 3. Xác thực trong trình duyệt

- **Access token chỉ nằm trong bộ nhớ**, không bao giờ ở `localStorage`, nơi mọi script bị chèn vào trang đều đọc được. Sau khi tải lại trang, token được khôi phục từ cookie refresh.
- **Refresh chỉ có một request tại một thời điểm**, theo hai lớp:
  1. Trong một tab: mọi lời gọi cùng chờ một promise.
  2. Giữa các tab: `navigator.locks` (Web Locks API) xếp hàng các lần refresh. Tab chạy sau gửi cookie mới mà tab trước vừa nhận, không gửi cookie đã bị xoay.

  Thiếu một trong hai lớp, hai request refresh song song sẽ làm API thu hồi cả family và người dùng bị đăng xuất oan.
- **Request nhận 401 thì refresh một lần rồi gửi lại.** Request nằm dưới `/auth/` thì không, để tránh vòng lặp.
- **`?next=` sau đăng nhập chỉ nhận đường dẫn cùng trang** (bắt đầu bằng `/`, không phải `//`), để không thành open redirect.

### 4. Kiểu dữ liệu sinh từ OpenAPI, kiểm tra lệch trong CI

- API bật **@nestjs/swagger CLI plugin**. Lúc build, plugin đọc kiểu trả về của controller (`Promise<OrderResponseDto>`) và sinh mô tả response. Trước đó Swagger không mô tả response nào.
- Script `pnpm --filter @questa/api openapi:export` dựng app ở **preview mode** (không khởi tạo provider, không cần DB hay Redis) và ghi `apps/api/openapi.json`. File này được commit.
- Web sinh `src/lib/api/schema.d.ts` bằng `openapi-typescript` và gọi API qua `openapi-fetch`, một client khoảng 4 KB sau gzip, kiểu chặt theo từng đường dẫn. `Idempotency-Key` cũng có kiểu, vì nó là header được khai báo trong OpenAPI.
- CI chạy lại cả hai bước rồi `git diff --exit-code`. Ai sửa API mà quên sinh lại kiểu thì CI báo đỏ.

### 5. Sơ đồ ghế vẽ trên canvas (react-konva)

Đêm diễn mẫu lớn nhất có hàng nghìn ghế. Vẽ bằng canvas tránh hàng nghìn node DOM. Lớp ghế được `memo`, nên di chuột (state của tooltip) không vẽ lại mọi ghế. Kéo để di chuyển, cuộn chuột để phóng to. Mỗi ghế có tên `seat-<hàng><số>` để test tìm được vị trí.

### 6. Trang thanh toán thuộc web

- **Cổng giả lập**: trang `/checkout/fake-gateway` thay cho trang của VNPay. Các nút gọi `POST /payments/fake/complete`; API ký IPN như VNPay rồi tự gửi. Sau đó trình duyệt đi tới Return URL, như với cổng thật.
- **Trang kết quả**: `/checkout/result/<provider>` chuyển nguyên bộ tham số đã ký sang `GET /api/v1/payments/return/<provider>`. API trả về "chữ ký hợp lệ, cổng báo thành công, đơn nào". Trang không bao giờ tự kết luận đơn đã trả tiền: nó chờ đơn chuyển trạng thái, và việc đó chỉ xảy ra qua IPN ([ADR-0012](0012-payments-ipn-and-refunds.md)).

### 7. Công cụ

- **Lint**: ESLint với `eslint-config-next` cho web, oxlint cho API ([ADR-0001](0001-monorepo-and-toolchain.md)). Bộ quy tắc của Next.js (core web vitals, React hooks, Server/Client Component) được bảo trì dưới dạng cấu hình ESLint; oxlint chưa có đủ các quy tắc tương đương.
- **Giao diện**:
  - shadcn/ui 4, kiểu `base-nova` (dựng trên Base UI).
  - Font Be Vietnam Pro, có bộ ký tự tiếng Việt.
  - Toàn bộ chữ trên giao diện bằng tiếng Việt, vì đây là trang bán vé cho khách Việt Nam, thanh toán VND qua VNPay.
- **Docker**:
  - `output: 'standalone'` cho image khoảng 300 MB, chạy `node apps/web/server.js`.
  - `outputFileTracingRoot` là gốc monorepo, vì pnpm đặt dependency ở đó.
- **Playwright** chạy trên **bản build production**, theo khuyến nghị của Next.js:
  - Mỗi file test tự tạo một đêm diễn mới qua API bằng tài khoản ban tổ chức có trong seed, nên các test không đụng dữ liệu của nhau.
  - CI dựng toàn bộ stack bằng `docker compose`, seed, rồi chạy test vào container web.

## Phương án đã loại

- **Web và API khác origin, dùng CORS.** Cookie refresh khi đó phải là `SameSite=None; Secure` và luôn cần HTTPS, kể cả ở local. Thêm cấu hình mà không được lợi gì cho một trang tối giản.
- **Giữ token phía server (Backend-for-Frontend với Server Actions).** An toàn hơn vì trình duyệt không bao giờ thấy access token. Nhưng phải viết lại toàn bộ luồng xác thực đã có ở API, vượt phạm vi "web tối giản". Có thể cân nhắc lại sau.
- **Lưu access token trong `localStorage`.** Bị XSS là mất token.
- **Sinh client đầy đủ bằng `orval` hoặc OpenAPI Generator.** Nặng hơn nhiều so với `openapi-typescript` + `openapi-fetch`, lại sinh thêm code phải review.
- **Vẽ sơ đồ ghế bằng SVG hoặc DOM.** Hàng nghìn node làm chậm mỗi lần render.
- **Cache danh mục bằng `'use cache'` của Next.js.** Số vé còn lại sẽ cũ. Hơn nữa `next build` sẽ phải gọi API, nên không build image ở CI được.

## Hệ quả

- `docker compose up -d --build` dựng cả trang web tại `http://localhost:${WEB_PORT}` (mặc định 3200).
- 4 test Playwright chạy trên trình duyệt thật: mua vé đầy đủ, hai khách tranh một ghế, hủy ở cổng thanh toán, chuyển hướng đăng nhập. CI chạy chúng trên toàn bộ stack.
- Đích của `rewrites` bị cố định lúc build. Đổi địa chỉ API nội bộ thì phải build lại image.
- Khách chưa đăng nhập tải trang sẽ thấy một request `401` trong console: lần thử khôi phục phiên khi chưa có cookie. Cookie là `httpOnly` nên JavaScript không biết trước nó có tồn tại hay không.
- Sơ đồ ghế cập nhật bằng polling 5 giây cho đến khi có WebSocket ở giai đoạn 7a.
- Deploy lên VPS (phần còn lại của giai đoạn 6) cần một reverse proxy có HTTPS đặt trước `web`. Chi tiết sẽ ghi khi deploy.
