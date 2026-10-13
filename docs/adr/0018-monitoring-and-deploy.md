# ADR-0018: Giám sát bằng Prometheus và Grafana; image gọn; deploy qua GHCR và SSH

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-13
- Giai đoạn: 9

## Bối cảnh

Giai đoạn 9 (đặc tả, mục 10):

- metrics Prometheus và dashboard Grafana cho thông lượng, độ trễ, độ dài queue, độ trễ consumer;
- deploy bản demo online lần đầu, toàn bộ stack trên VPS (ADR-0014);
- CI build image, đẩy lên GHCR, deploy qua SSH, HTTPS bằng Let's Encrypt;
- README hoàn chỉnh.

Định nghĩa hoàn thành: bản demo online chạy đầy đủ, README có sơ đồ kiến trúc, bảng benchmark và ảnh dashboard.

Ràng buộc từ ADR-0014:

- VPS dùng chung với một dự án đang chạy, project Compose của dự án kia tên `questa`;
- Nginx cổng 80/443 thuộc dự án kia;
- không build trên VPS;
- PostgreSQL 18 và Redis `noeviction`.

## Quyết định

### 1. Metrics: `prom-client` trực tiếp, mỗi tiến trình một registry

- **API**, tại `GET /api/v1/metrics`:
  - histogram `questa_http_request_duration_seconds` theo `method`, **mẫu route** (`/api/v1/performances/:id`, không phải id thật) và `status`;
  - metrics mặc định của Node, có tiền tố `questa_`: CPU, RSS, event loop lag, GC.
- **Worker**, tại `:9464/metrics` (một HTTP server nhỏ, vì worker không có HTTP của Nest):
  - outbox: số sự kiện chưa gửi, tuổi sự kiện cũ nhất;
  - số sự kiện relay đã gửi;
  - consumer: kết quả theo từng consumer (`applied`, `duplicate`, `dead-lettered`), độ trễ từ lúc sự kiện xảy ra tới lúc được áp dụng;
  - số job BullMQ theo queue và trạng thái;
  - số người trong hàng chờ ảo.

  Các gauge được tính lúc Prometheus scrape (`collect()`), nên không có vòng lặp nền nào phải cập nhật chúng.
- **Không dùng registry toàn cục**: test e2e tạo nhiều app trong cùng một tiến trình, nên đăng ký trùng tên metric sẽ ném lỗi.
- `/api/v1/metrics` **là nội bộ**: Prometheus đọc thẳng từng instance trên mạng Docker (`dns_sd_configs` kiểu A cho tên `api`), còn Nginx trả 404 cho đường này từ bên ngoài.
- Scrape bỏ qua cả hai throttler có tên (`@SkipThrottle({ ip: true, user: true })`). Một `@SkipThrottle()` trống chỉ bỏ qua throttler tên `default`; chính lần tập dượt deploy đã cho thấy scrape đang bị tính vào rate limit. Scrape cũng không được ghi log.
- **Grafana**: datasource và dashboard được nạp qua provisioning. JSON của dashboard sinh từ `docker/grafana/make-dashboard.py`. Ở local, Prometheus và Grafana chạy bằng `--profile monitoring`.

Dashboard đã cho thấy một điều benchmark tổng không thấy: lúc tải đỉnh, consumer `notifications` (SMTP và sinh ảnh QR) chậm hơn tốc độ sự kiện được tạo ra, p95 khoảng 28 s, trong khi `analytics` và `audit` theo kịp gần như tức thì.

### 2. Image gọn

- **Image API:** `pnpm deploy --config.auto-install-peers=false`. `@prisma/client` khai báo peer tùy chọn là Prisma CLI và TypeScript; pnpm vẫn cài chúng và mọi thứ chúng kéo theo (Prisma Studio, PGlite, `effect`…). Bỏ đi thì `node_modules` giảm từ 451 MB xuống 207 MB, image từ 889 MB xuống 546 MB.
- **Image migrate riêng:** chỉ có Prisma CLI, schema và migration, 608 MB, thay cho stage build 2,8 GB đã từng dùng để chạy `prisma migrate deploy`.

### 3. Deploy

- **`docker-compose.prod.yml`:** tên project `questa-booking` (khác `questa`). Image lấy từ `ghcr.io/mquanggdev/questa-booking-*:<git sha>`. Không mở cổng nào ra máy host. Nginx của stack (cân bằng tải 2 instance API, WebSocket) và Grafana gắn vào network dùng chung `${EDGE_NETWORK}`, với alias `questa-booking-nginx` và `questa-booking-grafana`. Thiếu secret nào thì Compose từ chối chạy, nhờ cú pháp `${VAR:?...}`.
- **`deploy/deploy.sh`:**
  - tạo network nếu chưa có;
  - `pull`, rồi `up` (migration chạy trước);
  - chờ `/health/ready` trả lời **qua Nginx của stack**;
  - nếu không khỏe, kể cả khi chính `up` lỗi vì container không khởi động được, thì quay về tag trước (ghi trong `.deployed-tag`).
- **Workflow `Deploy`:** chạy khi đẩy tag `v*` (tức là sau khi review, như mọi giai đoạn) hoặc bấm tay.
  - build ba image, có cache;
  - SSH bằng một key riêng cho deploy, với **host key được ghim sẵn** (`VPS_KNOWN_HOSTS`, không tin ở lần đầu kết nối);
  - chép file compose, cấu hình và script sang VPS;
  - chạy `deploy.sh`;
  - kiểm tra lần cuối qua HTTPS.
- **Đã tập dượt toàn bộ ở local** (`SKIP_PULL=1` với image gắn tag bằng tay):
  - deploy bình thường;
  - một image hỏng: tự quay về bản cũ, script thoát với mã 1;
  - seed demo;
  - định tuyến qua network dùng chung (web 200, Grafana 200, `/metrics` 404);
  - RAM lúc rảnh khoảng 1 GB.

  Lần tập dượt tìm ra hai lỗi của chính `deploy.sh`, đều đã sửa:
  - bước kiểm tra sức khỏe gọi `compose exec` thiếu `IMAGE_TAG`, nên luôn báo "không khỏe";
  - `up` lỗi làm script dừng ngay vì `set -e`, mà không quay về bản cũ.
- **Nginx của VPS** nằm trong repo dự án kia. Mẫu cấu hình ở `deploy/nginx-vps.conf.example` tránh ba cách làm Nginx không khởi động được:
  - địa chỉ đích để trong biến, được Docker DNS phân giải lúc có request;
  - chỉ thêm block 443 khi chứng chỉ đã có;
  - network được tạo trước.

### 4. Bản demo: tài khoản ban tổ chức chỉ xem, seed an toàn

- `users.is_demo`: access token của tài khoản này mang `demo: true`, và `DemoReadOnlyGuard` từ chối mọi request không phải đọc (`DEMO_READ_ONLY`, 403). Route công khai (đăng nhập, refresh, đăng xuất) vẫn đi qua được. Mật khẩu được ghi công khai, để người xem thử được trang theo dõi mở bán.
- `dist/scripts/demo-seed.js` tạo dữ liệu bằng chính các service nghiệp vụ, **không bao giờ xóa**, và tự dừng nếu đã có concert. Seed phát triển (`prisma db seed`) thì xóa sạch DB, và từ chối chạy ở môi trường production.
- Bản demo thanh toán qua cổng giả lập (`ALLOW_FAKE_PAYMENTS=true`), nên không có tiền thật đi đâu cả.
- Email được Mailpit giữ lại và không công khai, để địa chỉ email của người dùng thử không bị lộ.

## Phương án đã loại

- **`@willsoto/nestjs-prometheus`.** Thêm một lớp bọc chỉ để làm việc `prom-client` vốn đã làm; worker vẫn cần server riêng.
- **Gắn số order hay id vào nhãn metric.** Mỗi id thành một chuỗi số liệu riêng (cardinality bùng nổ). Chỉ dùng mẫu route.
- **Build image trên VPS.** Chậm, và tốn RAM ngay trên máy đang phục vụ người dùng (ADR-0014).
- **Image riêng tư trên GHCR.** Phải giữ thêm một token đọc trên VPS; image không chứa secret nào, nên chọn công khai (chủ dự án đồng ý).
- **Watchtower hoặc pull tự động.** Không có bước kiểm tra sức khỏe và quay về bản cũ, và khó biết đang chạy bản nào.
- **Tài khoản ban tổ chức demo có đủ quyền.** Ai cũng có thể hủy đêm diễn hoặc làm hỏng dữ liệu demo.

## Hệ quả

- Prometheus giữ dữ liệu 7 ngày. Grafana công khai ở chế độ chỉ xem (chủ dự án đồng ý).
- Mỗi migration phải tương thích với code của bản trước (expand rồi contract), vì việc quay về bản cũ không đảo ngược schema.
- Deploy cần chủ dự án làm một lần các bước ngoài repo: DNS, Nginx và chứng chỉ trong repo dự án kia, `.env` trên VPS, secret của GitHub, chuyển package sang Public. Chi tiết trong [docs/deploy-vps.md](../deploy-vps.md).
