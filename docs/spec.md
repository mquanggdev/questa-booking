# Đặc tả dự án: Questa Booking — hệ thống bán vé concert chịu tải cao

Phiên bản 2 · 2026-10-02 · @minhquanggdev

Bản này thay thế bản đề xuất ban đầu. Nó giữ nguyên ý tưởng và thêm các quyết định đã chốt giữa chủ dự án và agent. Quy tắc làm việc của agent nằm ở [`AGENTS.md`](../AGENTS.md). Lý do của từng quyết định kỹ thuật nằm ở [`docs/adr/`](adr/).

## 1. Tổng quan

Questa Booking là backend của một nền tảng bán vé concert. Nó phải bán đúng số ghế khi hàng nghìn người cùng mua một lúc. Đây là dự án portfolio cho vị trí Backend Developer: giá trị nằm ở tính đúng dưới tải cao và ở số liệu đo được, không nằm ở số lượng tính năng. Dự án đồng thời là nơi học có hệ thống các công nghệ: NestJS, PostgreSQL, Prisma, Redis, BullMQ, Kafka, Next.js.

### Sản phẩm

- Một concert có một hoặc nhiều đêm diễn (`performances`). Mỗi đêm diễn có sơ đồ, giá và tồn kho vé riêng, và là đơn vị bán vé.
- Mỗi đêm diễn chia thành các khu theo hạng vé, ví dụ VIP, CAT 1, CAT 2 và khu đứng.
- Có hai loại khu: khu ngồi bán theo từng ghế có số, khu đứng bán theo số lượng.
- Vé mở bán theo đợt: đợt bán trước (`PRESALE`) cho tài khoản có mã ưu tiên, sau đó là đợt bán chung (`GENERAL`).
- Mỗi tài khoản mua tối đa 6 vé cho một đêm diễn (cấu hình được), để hạn chế đầu cơ.
- Vé đã thanh toán không hoàn theo yêu cầu của khách; chỉ hoàn tiền khi đêm diễn bị hủy.

### Mục tiêu

- Không bao giờ bán một ghế cho hai người, dưới mọi mức tải.
- Chịu được lượng truy cập tăng đột biến lúc mở bán mà không sập.
- Mỗi công nghệ có mặt vì một bài toán cụ thể, và lý do được ghi lại.
- Có số liệu load test trước và sau từng cải tiến.

### Vai trò người dùng

| Vai trò | Việc làm được |
| --- | --- |
| Khách (`CUSTOMER`) | Xem concert, chọn ghế hoặc số lượng vé đứng, giữ vé, thanh toán, nhận vé QR, xem lịch sử đơn |
| Ban tổ chức (`ORGANIZER`) | Tạo concert và đêm diễn, cấu hình khu và giá, đặt các đợt mở bán, theo dõi mở bán trực tiếp, hủy đêm diễn |
| Soát vé (`STAFF`) | Quét mã QR để check-in, mỗi vé dùng một lần |

### Giao diện

| Giao diện | Mức làm |
| --- | --- |
| Trang mua vé (Next.js) | Tối giản: danh sách concert, sơ đồ ghế, chọn số lượng vé đứng, thanh toán, vé QR. Sơ đồ ghế cập nhật realtime từ mốc M2 |
| Trang theo dõi mở bán | Một trang: số vé đã bán theo khu, doanh thu, số vé đang giữ, số người trong hàng chờ, cập nhật realtime |
| Dashboard kỹ thuật | Grafana: thông lượng, độ trễ, độ dài queue, độ trễ consumer |
| Quản trị của ban tổ chức | Không có giao diện; thao tác qua API và Swagger, dữ liệu mẫu tạo bằng script seed |
| Soát vé | API là đủ; trang quét QR là phần tùy chọn làm sau cùng |

### Ngoài phạm vi

- Trang quản trị cho ban tổ chức.
- Hoàn vé theo yêu cầu của khách, bán lại hoặc chuyển nhượng vé.
- Mã giảm giá, đánh giá, chat hỗ trợ.
- Ứng dụng di động, đối soát kế toán, chống gian lận nâng cao.
- Tích hợp cổng thanh toán ở chế độ production. Chỉ dùng sandbox.
- Microservices, Kubernetes, Elasticsearch, GraphQL, MongoDB.

## 2. Công nghệ

Hệ thống là một monolith NestJS chia module, chạy nhiều instance sau Nginx. Repo là pnpm workspace. Phiên bản được khóa trong `pnpm-lock.yaml`.

| Nhóm | Công nghệ | Dùng cho bài toán nào |
| --- | --- | --- |
| Runtime | Node.js 24 LTS, pnpm workspace | Một repo cho API và web |
| Framework | NestJS 12, TypeScript 6 (strict, ESM) | Khung backend |
| Database | PostgreSQL 18 | Dữ liệu chính, transaction, khóa dòng, ràng buộc unique |
| ORM | Prisma 7 (driver adapter `pg`) | Truy vấn và migration; lệnh khóa viết raw SQL |
| Cache và khóa | Redis 8 | Giữ ghế có TTL, cache, rate limiting, hàng chờ ảo |
| Hàng đợi | BullMQ | Nhả ghế hết hạn, hàng chờ ảo, retry, hoàn tiền |
| Luồng sự kiện | Kafka (KRaft, một node), client `@confluentinc/kafka-javascript` | Phát sự kiện đơn hàng cho nhiều consumer độc lập |
| Realtime | Socket.IO với Redis adapter | Cập nhật sơ đồ ghế qua nhiều instance |
| Xác thực | JWT access token, refresh token xoay vòng lưu hash trong DB, RBAC | Đăng nhập và phân quyền ba vai trò |
| Thanh toán | VNPay sandbox (tái sử dụng code của chủ dự án), cộng một provider giả lập | Thanh toán, IPN, hoàn tiền |
| Kiểm thử | Vitest, Supertest (API); Playwright (web e2e) | Unit, e2e, kiểm thử luồng người dùng |
| Lint, format | oxlint (type-aware), Prettier | Mặc định của NestJS 12 |
| Load test | k6 (chạy bằng Docker) | Bắn tải đồng thời, đo thông lượng và độ trễ |
| Tài liệu API | Swagger (OpenAPI) | Mô tả API; sinh kiểu cho web bằng `openapi-typescript` |
| Web | Next.js, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, react-konva | Trang mua vé và trang theo dõi mở bán |
| Hạ tầng | Docker, Docker Compose, Nginx | Đóng gói, chạy nhiều instance, cân bằng tải |
| CI/CD | GitHub Actions, GitHub Container Registry | Test, build image, deploy |
| Giám sát | Pino, Prometheus, Grafana | Log có cấu trúc, metrics khi load test |

## 3. Kiến trúc

Một codebase NestJS chạy ở hai chế độ: tiến trình API (HTTP và WebSocket) và tiến trình worker (BullMQ, outbox relay, Kafka consumer). Tách tiến trình giúp worker không tranh tài nguyên với request của người dùng. Hai tiến trình dùng chung một image Docker, chỉ khác lệnh khởi động.

### Thành phần

| Thành phần | Số lượng | Nhiệm vụ |
| --- | --- | --- |
| Nginx | 1 | Cân bằng tải, hỗ trợ WebSocket, kết thúc TLS |
| API | 2 trở lên | REST API, WebSocket Gateway |
| Worker | 1 trở lên | Xử lý job BullMQ, outbox relay, Kafka consumer |
| PostgreSQL | 1 | Nguồn dữ liệu chính thức |
| Redis | 1 | Giữ ghế, cache, BullMQ, pub/sub cho WebSocket |
| Kafka | 1 | Luồng sự kiện đơn hàng |

### Nguyên tắc

- PostgreSQL là nguồn sự thật. Redis chỉ là lớp tăng tốc; nếu Redis mất dữ liệu, hệ thống vẫn không được bán trùng.
- API không giữ trạng thái trong bộ nhớ, để chạy được nhiều instance.
- Mọi thao tác ghi quan trọng đều idempotent.
- Module giao tiếp qua service công khai, không truy cập bảng của module khác.

### Cấu trúc thư mục

```text
apps/
  api/                    # NestJS
    src/
      main.ts             # khởi động API
      worker.ts           # khởi động worker (từ giai đoạn 4)
      app.module.ts
      config/             # đọc và validate biến môi trường (zod)
      common/             # decorator, filter, guard, interceptor, pipe dùng chung
      prisma/             # PrismaModule, PrismaService
      redis/              # RedisModule
      queue/              # cấu hình BullMQ (giai đoạn 4)
      kafka/              # producer, consumer (giai đoạn 8)
      modules/
        health/
        auth/
        users/
        concerts/         # concert và đêm diễn (khu, đợt mở bán): một aggregate
        seats/            # sơ đồ ghế, WebSocket gateway
        reservations/     # giữ vé, nhả vé
        orders/           # đơn hàng, state machine
        payments/         # cổng thanh toán, IPN, hoàn tiền
        tickets/          # phát hành vé, check-in
        waiting-room/     # hàng chờ ảo
        outbox/           # bảng outbox, relay sang Kafka
        notifications/    # Kafka consumer
        analytics/        # Kafka consumer
        audit/            # Kafka consumer
      generated/          # Prisma client (sinh ra, không commit)
    prisma/               # schema.prisma, migrations/, seed.ts
    test/                 # e2e test
  web/                    # Next.js (từ giai đoạn 6)
load-tests/               # kịch bản k6 và script kiểm tra bất biến
docker/                   # cấu hình nginx, prometheus, grafana
docs/
  spec.md
  benchmarks.md
  adr/                    # quyết định kiến trúc
  learning/               # ghi chú học tập (chỉ ở máy chủ dự án, không commit)
  showcase/               # sơ đồ, demo, video (chỉ ở máy chủ dự án, không commit)
.claude/skills/           # skill tham khảo cho agent
AGENTS.md                 # quy tắc cho agent
docker-compose.yml
```

Mỗi module tính năng theo quy ước của NestJS: `*.module.ts`, `*.controller.ts`, `*.service.ts`, thư mục `dto/`, và unit test `*.spec.ts` đặt cạnh file được test.

Thư mục chỉ được tạo khi giai đoạn tương ứng cần đến.

## 4. Mô hình dữ liệu

Database tự bảo vệ tính đúng bằng ràng buộc, kể cả khi code ứng dụng có lỗi. Khóa chính dùng UUID v7 do PostgreSQL sinh (`uuidv7()`), tiền lưu bằng số nguyên VND, thời gian lưu dạng `timestamptz`. Tên bảng và cột dạng `snake_case`, model Prisma dạng `PascalCase`.

Thuật ngữ: `concerts` là chương trình; `performances` là một đêm diễn cụ thể và là đơn vị bán vé. Từ "event" chỉ dùng cho sự kiện nghiệp vụ (Kafka, outbox, WebSocket), để không nhầm lẫn.

### Bảng

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| `users` | `email`, `password_hash`, `full_name`, `role` | `email` unique |
| `refresh_tokens` | `user_id`, `family_id`, `token_hash`, `expires_at`, `revoked_at`, `replaced_by` | Xoay vòng: mỗi lần dùng thì thu hồi token cũ và cấp token mới trong cùng family. Dùng lại token đã thu hồi thì thu hồi cả family |
| `concerts` | `organizer_id`, `name`, `artist`, `description` | Chương trình, gồm một hoặc nhiều đêm diễn |
| `performances` | `concert_id`, `venue`, `starts_at`, `status`, `max_tickets_per_user` | `status`: `DRAFT`, `PUBLISHED`, `CANCELLED` |
| `sale_phases` | `performance_id`, `type`, `starts_at`, `ends_at` | `type`: `PRESALE`, `GENERAL` |
| `presale_codes` | `sale_phase_id`, `code`, `redeemed_by`, `redeemed_at` | `code` unique, mỗi mã dùng một lần |
| `zones` | `performance_id`, `name`, `type`, `price`, `capacity`, `held_count`, `sold_count` | `type`: `SEATED`, `STANDING`. Check `held_count + sold_count <= capacity` |
| `seats` | `performance_id`, `zone_id`, `row_label`, `seat_number`, `status` | Chỉ có ở khu `SEATED`. Unique (`performance_id`, `zone_id`, `row_label`, `seat_number`) |
| `orders` | `user_id`, `performance_id`, `status`, `total_amount`, `expires_at`, `idempotency_key`, `request_hash` | Unique (`user_id`, `idempotency_key`); `request_hash` phát hiện key bị dùng lại cho request khác |
| `order_items` | `order_id`, `zone_id`, `seat_id`, `price`, `released_at` | Mỗi dòng là một vé. `seat_id` rỗng với vé đứng. Partial unique index trên `seat_id` khi `released_at IS NULL` |
| `payments` | `order_id`, `provider`, `provider_txn_id`, `amount`, `status`, `raw_payload` | `provider_txn_id` unique |
| `tickets` | `order_item_id`, `code`, `checked_in_at`, `checked_in_by` | `order_item_id` unique, `code` unique, ngẫu nhiên 128-bit |
| `outbox_events` | `aggregate_id`, `event_type`, `payload`, `created_at`, `published_at` | Index trên `published_at IS NULL` |
| `processed_events` | `consumer`, `event_id` | Khóa chính kép, giúp consumer idempotent |
| `performance_sales_stats` | `performance_id`, `zone_id`, `tickets_sold`, `revenue` | Do consumer thống kê cập nhật |
| `audit_logs` | `actor_id`, `action`, `entity`, `entity_id`, `metadata`, `created_at` | Do consumer audit ghi |

Không có cột `version`: giai đoạn 3 dùng `xmin` (phiên bản dòng có sẵn của PostgreSQL) cho cách optimistic, và benchmark không chỉ ra cách nào nhanh hơn ([ADR-0008](adr/0008-seat-and-standing-locking.md)).

### Ràng buộc quan trọng nhất

Partial unique index trên `order_items(seat_id) WHERE released_at IS NULL` đảm bảo một ghế chỉ thuộc tối đa một đơn còn hiệu lực. Khi đơn hết hạn, bị hủy hoặc được hoàn tiền, hệ thống ghi `released_at` cho các dòng của đơn đó. Prisma không khai báo được partial index trong schema, nên viết bằng SQL trong migration.

### Tồn kho khu đứng

Khu đứng không có ghế, nên tồn kho là hai bộ đếm trên `zones`: `held_count` và `sold_count`. Giữ vé là một câu lệnh có điều kiện:

```sql
UPDATE zones SET held_count = held_count + $n
WHERE id = $1 AND held_count + sold_count + $n <= capacity
```

Không có dòng nào bị ảnh hưởng nghĩa là khu đã hết vé. Ràng buộc check trên bảng là lớp bảo vệ cuối cùng.

Khi 5.000 người cùng cập nhật một dòng, các câu lệnh phải xếp hàng chạy lần lượt (hot row). Giai đoạn 3 đã đo: với câu `UPDATE` có điều kiện chạy cuối transaction, chỉ khoảng 3,6% thời gian là chờ khóa, còn nút thắt là CPU của tiến trình API. Vì vậy chưa chia bộ đếm thành nhiều dòng; sẽ đo lại khi có nhiều instance ở giai đoạn 7a ([ADR-0008](adr/0008-seat-and-standing-locking.md)).

### Trạng thái ghế

| Trạng thái | Ý nghĩa |
| --- | --- |
| `AVAILABLE` | Chọn được |
| `HELD` | Đang được một đơn `PENDING` giữ |
| `SOLD` | Thuộc một đơn `PAID` |

### Trạng thái đơn hàng

| Từ | Sang | Khi nào |
| --- | --- | --- |
| (mới) | `PENDING` | Giữ vé thành công |
| `PENDING` | `PAID` | Cổng thanh toán báo thành công, đúng số tiền, và đơn chưa quá hạn cộng thời gian ân hạn |
| `PENDING` | `EXPIRED` | Quá `expires_at` cộng thời gian ân hạn mà chưa thanh toán |
| `PENDING` | `CANCELLED` | Người dùng hủy, hoặc đêm diễn bị hủy |
| `EXPIRED`, `CANCELLED` | `REFUND_PENDING` | Tiền về sau khi đơn đã đóng |
| `PAID` | `REFUND_PENDING` | Đêm diễn bị hủy |
| `REFUND_PENDING` | `REFUNDED` | Cổng thanh toán xác nhận hoàn tiền |

Mọi bước chuyển khác đều không hợp lệ và phải bị từ chối ở tầng service. Bước chuyển thực hiện bằng `UPDATE ... WHERE status = <trạng thái cũ>` và kiểm tra số dòng bị ảnh hưởng.

## 5. Tham số mặc định

Tất cả đọc từ biến môi trường.

| Tham số | Mặc định |
| --- | --- |
| Thời gian giữ vé (`HOLD_TTL`) | 10 phút |
| Thời gian ân hạn thanh toán (`PAYMENT_GRACE`) | 2 phút |
| Số vé tối đa một tài khoản cho một đêm diễn | 6 |
| Access token | 15 phút |
| Refresh token | 7 ngày |

## 6. Luồng nghiệp vụ và bất biến

### Luồng A: Giữ vé

1. Kiểm tra đêm diễn đang trong một đợt mở bán. Nếu là đợt bán trước, tài khoản phải đã kích hoạt mã ưu tiên. Kiểm tra vé vào cửa của hàng chờ ảo còn hiệu lực (nếu bật).
2. Nếu `Idempotency-Key` đã tồn tại cho người dùng này, trả về đơn cũ. Nếu hai request cùng key đến song song, request thua sẽ đụng ràng buộc unique; lỗi này được bắt lại và trả về đơn đã có, không trả 500.
3. Giữ chỗ trong Redis bằng một Lua script, làm cổng lọc mềm để chặn bớt tải trước khi vào DB. Với ghế ngồi: đặt key `seat:hold:{seatId}` với `NX` và TTL bằng thời gian giữ cộng thời gian ân hạn. Với vé đứng: giảm bộ đếm số vé còn lại của khu, không cho xuống dưới 0. Chỉ cần một phần thất bại thì không giữ gì cả.
4. Mở transaction và lấy `pg_advisory_xact_lock` theo (`user_id`, `performance_id`). Đếm số vé tài khoản đang giữ và đã mua cho đêm diễn; từ chối nếu vượt giới hạn.
5. Trong transaction đó, với ghế ngồi: `UPDATE seats SET status = 'HELD' WHERE ... AND status = 'AVAILABLE'` rồi kiểm tra số dòng (đã so sánh với `FOR UPDATE` và optimistic theo `xmin`, [ADR-0008](adr/0008-seat-and-standing-locking.md)). Với vé đứng: câu `UPDATE zones` có điều kiện, chạy cuối transaction để giữ khóa dòng nóng ngắn nhất.
6. Tạo đơn `PENDING` với `expires_at` và một dòng `order_items` cho mỗi vé.
7. Nếu transaction thất bại, hoàn tác những gì đã giữ trong Redis.
8. Tạo delayed job `expire-order` chạy tại `expires_at` cộng thời gian ân hạn.
9. Phát `seat.updated` và `zone.updated` qua WebSocket.

### Luồng B: Thanh toán

1. Khách yêu cầu thanh toán cho đơn `PENDING`. Hệ thống tạo bản ghi `payments` và trả về URL của cổng thanh toán. Thời hạn của URL (`vnp_ExpireDate`) bằng `expires_at` của đơn.
2. Cổng thanh toán gọi IPN. Hệ thống xác minh chữ ký trước khi làm gì khác. Return URL (qua trình duyệt) chỉ để hiển thị, không bao giờ đổi trạng thái đơn.
3. Nếu `provider_txn_id` đã được xử lý, trả về kết quả cũ và dừng.
4. Kiểm tra số tiền trong IPN bằng `total_amount` của đơn; sai thì từ chối.
5. Trong một transaction: nếu đơn còn `PENDING` thì chuyển đơn sang `PAID`, ghế sang `SOLD`, tạo vé, ghi sự kiện `order.paid` vào `outbox_events`.
6. Nếu đơn đã `EXPIRED` hoặc `CANCELLED`: ghi nhận thanh toán, chuyển đơn sang `REFUND_PENDING`, tạo job hoàn tiền. Không bao giờ lấy lại ghế cho đơn đã đóng.
7. IPN được xử lý đồng bộ và trả mã `RspCode` theo chuẩn VNPay. Nếu VNPay không nhận được `00`, nó tự gửi lại; nhờ bước 3, việc gửi lại an toàn. Riêng việc hoàn tiền mới đi qua BullMQ (retry với backoff, quá số lần thì vào dead letter queue).

Thời gian ân hạn tránh trường hợp khách trả tiền ở giây cuối nhưng IPN về sau khi đơn đã hết hạn.

### Luồng C: Hết hạn giữ vé

1. Job `expire-order` chuyển đơn `PENDING` sang `EXPIRED`. Nếu đơn không còn `PENDING`, job kết thúc mà không làm gì.
2. Trong cùng transaction: ghế về `AVAILABLE`, ghi `released_at` cho `order_items`, ghi sự kiện `order.expired` vào outbox.
3. Xóa key Redis và phát `seat.updated` qua WebSocket.
4. Một job quét định kỳ mỗi phút xử lý các đơn quá hạn bị sót, phòng khi delayed job bị mất.

### Vé khu đứng trong luồng B và C

Với vé đứng, bước đổi trạng thái ghế được thay bằng cập nhật bộ đếm của khu. Thanh toán thành công chuyển số vé từ `held_count` sang `sold_count`. Hết hạn hoặc hủy đơn giảm `held_count` và trả số vé về bộ đếm trong Redis. Một job đối chiếu bộ đếm Redis với DB, chỉ chạy cho khu không có giao dịch đang dở.

### Đợt mở bán và mã ưu tiên

Mỗi đêm diễn có một hoặc nhiều đợt mở bán không chồng thời gian. Trong đợt `PRESALE`, khách kích hoạt mã bằng:

```sql
UPDATE presale_codes SET redeemed_by = $1, redeemed_at = now()
WHERE code = $2 AND redeemed_by IS NULL
```

Chỉ tài khoản đã kích hoạt mới giữ được vé. Đợt `GENERAL` mở cho mọi tài khoản.

### Hủy đêm diễn

1. Ban tổ chức hủy đêm diễn; `performances.status` chuyển sang `CANCELLED` và hệ thống ngừng nhận giữ vé.
2. Mọi đơn `PENDING` chuyển sang `CANCELLED`, vé đang giữ được nhả.
3. Mọi đơn `PAID` chuyển sang `REFUND_PENDING`; mỗi đơn có một job hoàn tiền riêng trong BullMQ.
4. Khi cổng thanh toán xác nhận, đơn chuyển sang `REFUNDED`, vé bị vô hiệu, sự kiện `order.refunded` được ghi vào outbox.

### Luồng D: Soát vé

Check-in là một câu lệnh duy nhất:

```sql
UPDATE tickets SET checked_in_at = now(), checked_in_by = $2
WHERE code = $1 AND checked_in_at IS NULL
```

Không có dòng nào bị ảnh hưởng thì đọc lại vé để trả lời rõ: "không tồn tại" hoặc "đã check-in lúc X bởi Y".

### Hàng chờ ảo

Khi đêm diễn bật hàng chờ, người dùng vào một sorted set trong Redis theo thời điểm đến. Worker cho vào từng đợt theo tốc độ cấu hình và cấp vé vào cửa có thời hạn, gắn với tài khoản và đêm diễn. API giữ vé từ chối request không có vé vào cửa hợp lệ. Vị trí trong hàng được đẩy qua WebSocket.

### Sơ đồ ghế realtime

- `GET /performances/:id/seats` trả bản chụp trạng thái kèm số thứ tự `seq`.
- Thay đổi được gom lại và gửi theo lô mỗi 200–500 ms cho mỗi đêm diễn, kèm `seq`.
- Client chỉ áp dụng các lô có `seq` lớn hơn bản chụp. Nếu thấy hụt `seq` thì tải lại bản chụp.

### Bất biến

| Mã | Bất biến | Cơ chế bảo vệ |
| --- | --- | --- |
| I1 | Một ghế thuộc tối đa một đơn còn hiệu lực | Partial unique index, khóa dòng |
| I2 | Số ghế `SOLD` bằng số `order_items` của đơn `PAID` | Transaction ở luồng B |
| I3 | Không ghế nào ở trạng thái `HELD` quá thời gian giữ cộng thời gian ân hạn cộng 1 phút | Delayed job, job quét định kỳ |
| I4 | Mỗi giao dịch của cổng thanh toán được xử lý đúng một lần | Unique `provider_txn_id` |
| I5 | Cùng `Idempotency-Key` luôn trả về cùng một đơn | Unique (`user_id`, `idempotency_key`) |
| I6 | Mỗi vé check-in đúng một lần | Câu `UPDATE` có điều kiện |
| I7 | Mỗi đơn `PAID` có đúng một sự kiện `order.paid`, và mỗi consumer áp dụng nó đúng một lần | Outbox trong cùng transaction, `processed_events` |
| I8 | Tiền nhận cho đơn đã đóng luôn được hoàn | Luồng B bước 6 |
| I9 | Ở mỗi khu đứng, số vé đang giữ cộng đã bán không vượt sức chứa và khớp với số `order_items` còn hiệu lực | Câu `UPDATE` có điều kiện, ràng buộc check |
| I10 | Một tài khoản không giữ và mua quá giới hạn vé của một đêm diễn, kể cả khi gửi nhiều request song song | Advisory lock theo tài khoản và đêm diễn |
| I11 | Trong đợt bán trước chỉ tài khoản đã kích hoạt mã mới giữ được vé, và mỗi mã chỉ dùng một lần | Câu `UPDATE` có điều kiện trên `presale_codes` |
| I12 | Đơn chỉ chuyển sang `PAID` khi số tiền nhận được bằng `total_amount` | Luồng B bước 4 |

Mỗi bất biến có ít nhất một test tự động, và một script kiểm tra trong `load-tests/verify/` chạy sau mỗi lần load test.

## 7. API

Mọi API có tiền tố `/api/v1`, trả JSON, và được mô tả trong Swagger tại `/api/docs`. Lỗi trả về theo một định dạng thống nhất gồm `code`, `message` và `details`.

Mặc định mọi endpoint cần access token (`Authorization: Bearer`). Endpoint công khai được đánh dấu riêng; trên endpoint công khai, token hợp lệ (nếu có) vẫn được đọc, ví dụ để ban tổ chức xem được bản nháp của mình. Refresh token nằm trong cookie `httpOnly`, `SameSite=Strict`, chỉ gửi tới `/api/v1/auth`.

| Phương thức | Đường dẫn | Quyền | Mô tả |
| --- | --- | --- | --- |
| POST | `/auth/register` | Công khai | Đăng ký |
| POST | `/auth/login` | Công khai | Đăng nhập, trả access token trong body và đặt refresh token vào cookie |
| POST | `/auth/refresh` | Cookie refresh | Xoay vòng refresh token, cấp access token mới |
| POST | `/auth/logout` | Cookie refresh | Thu hồi refresh token (cả family) và xóa cookie |
| GET | `/users/me` | Đã đăng nhập | Thông tin tài khoản hiện tại |
| GET | `/concerts` | Công khai | Danh sách concert, phân trang, có cache |
| GET | `/concerts/:id` | Công khai | Chi tiết concert và các đêm diễn đã công bố (chủ concert thấy cả bản nháp), có cache |
| POST | `/concerts` | `ORGANIZER` | Tạo concert |
| POST | `/concerts/:id/performances` | `ORGANIZER` | Tạo đêm diễn kèm khu, ghế và đợt mở bán |
| GET | `/performances/:id` | Công khai | Chi tiết đêm diễn, khu, giá, đợt mở bán, có cache |
| PATCH | `/performances/:id` | `ORGANIZER` | Sửa đêm diễn, xóa cache liên quan |
| POST | `/performances/:id/publish` | `ORGANIZER` | Công bố đêm diễn |
| POST | `/performances/:id/cancel` | `ORGANIZER` | Hủy đêm diễn và hoàn tiền mọi đơn đã thanh toán |
| GET | `/performances/:id/seats` | Công khai | Bản chụp trạng thái ghế kèm `seq`, và số vé còn lại của từng khu đứng |
| GET | `/performances/:id/stats` | `ORGANIZER` | Số vé đã bán theo khu, doanh thu, số vé đang giữ, độ dài hàng chờ |
| POST | `/performances/:id/presale/redeem` | `CUSTOMER` | Kích hoạt mã ưu tiên cho đợt bán trước |
| POST | `/performances/:id/queue` | `CUSTOMER` | Vào hàng chờ ảo |
| GET | `/performances/:id/queue/me` | `CUSTOMER` | Vị trí trong hàng, vé vào cửa nếu đã đến lượt |
| POST | `/reservations` | `CUSTOMER` | Giữ vé: danh sách ghế ngồi và số lượng theo khu đứng. Bắt buộc header `Idempotency-Key`; gửi lại cùng key trả lại đơn cũ với header `Idempotent-Replayed: true`, cùng key cho request khác trả `422` ([ADR-0009](adr/0009-idempotency-and-ticket-limit.md)) |
| GET | `/orders` | `CUSTOMER` | Lịch sử đơn của tôi |
| GET | `/orders/:id` | `CUSTOMER` | Chi tiết đơn |
| POST | `/orders/:id/cancel` | `CUSTOMER` | Hủy đơn `PENDING` |
| POST | `/orders/:id/pay` | `CUSTOMER` | Tạo thanh toán, trả URL cổng thanh toán |
| GET | `/payments/ipn/:provider` | Chữ ký của cổng | Nhận kết quả thanh toán (VNPay gọi IPN bằng GET) |
| GET | `/tickets` | `CUSTOMER` | Vé của tôi kèm mã QR |
| POST | `/tickets/check-in` | `STAFF` | Check-in bằng mã vé |
| GET | `/health` | Công khai | Liveness: tiến trình còn sống |
| GET | `/health/ready` | Công khai | Readiness: DB và Redis truy cập được |
| GET | `/metrics` | Nội bộ | Metrics cho Prometheus |

### WebSocket

| Namespace | Sự kiện | Hướng | Nội dung |
| --- | --- | --- | --- |
| `/seats` | `join` | Client gửi | `performanceId` muốn theo dõi |
| `/seats` | `seats.batch` | Server gửi | `seq` và danh sách (`seatId`, trạng thái mới) |
| `/seats` | `zone.updated` | Server gửi | Số vé còn lại của khu đứng |
| `/queue` | `queue.position` | Server gửi | Vị trí hiện tại trong hàng chờ |
| `/queue` | `queue.admitted` | Server gửi | Vé vào cửa và thời hạn |
| `/sales` | `sales.updated` | Server gửi, chỉ cho `ORGANIZER` | Số vé đã bán theo khu, doanh thu, số vé đang giữ, độ dài hàng chờ |

### Giới hạn tốc độ

Áp dụng theo người dùng và theo IP, lưu bộ đếm trong Redis để đúng trên nhiều instance. Giới hạn chặt hơn cho `/reservations` và `/auth/login`.

## 8. BullMQ, Kafka và outbox

BullMQ xử lý công việc nền có hẹn giờ và retry bên trong ứng dụng; Kafka phát sự kiện nghiệp vụ đã xảy ra cho nhiều bên tiêu thụ độc lập. Hai công cụ không thay thế nhau và không được dùng lẫn vai.

| Việc | Công cụ | Lý do |
| --- | --- | --- |
| Nhả vé khi hết hạn | BullMQ | Cần delayed job |
| Hoàn tiền | BullMQ | Cần retry với backoff và dead letter queue |
| Cho người dùng vào từ hàng chờ ảo | BullMQ | Cần job lặp lại có giới hạn tốc độ |
| Thông báo đơn đã thanh toán, hết hạn, hoàn tiền | Kafka | Một sự kiện, nhiều consumer độc lập |

### Hàng đợi BullMQ

| Queue | Job | Ghi chú |
| --- | --- | --- |
| `reservations` | `expire-order` | Delayed, `jobId` bằng `orderId` để không tạo trùng |
| `reservations` | `sweep-expired` | Lặp lại mỗi phút |
| `reservations` | `reconcile-standing` | Đối chiếu bộ đếm khu đứng Redis với DB |
| `payments` | `refund` | Retry backoff lũy thừa, tối đa 5 lần, sau đó vào DLQ |
| `waiting-room` | `admit-batch` | Lặp lại theo chu kỳ cấu hình |

### Kafka

| Topic | Khóa partition | Sự kiện |
| --- | --- | --- |
| `orders.events` | `orderId` | `order.paid`, `order.expired`, `order.cancelled`, `order.refunded` |

| Consumer group | Module | Việc làm khi nhận `order.paid` |
| --- | --- | --- |
| `notifications` | `notifications` | Gửi email kèm vé QR |
| `analytics` | `analytics` | Cập nhật `performance_sales_stats`, phát `sales.updated` |
| `audit` | `audit` | Ghi `audit_logs` |

Mỗi sự kiện có cấu trúc chung:

```json
{
  "eventId": "uuid",
  "eventType": "order.paid",
  "occurredAt": "2026-10-02T13:00:00Z",
  "version": 1,
  "data": {
    "orderId": "uuid",
    "userId": "uuid",
    "performanceId": "uuid",
    "totalAmount": 1500000,
    "items": [{ "zoneId": "uuid", "seatId": "uuid hoặc null" }]
  }
}
```

### Outbox pattern

Ứng dụng không bao giờ gửi thẳng vào Kafka từ luồng nghiệp vụ. Sự kiện được ghi vào `outbox_events` trong cùng transaction với thay đổi nghiệp vụ, nên hoặc cả hai cùng thành công, hoặc cả hai cùng không xảy ra.

1. Outbox relay chạy trong worker, lấy các dòng chưa gửi bằng `SELECT ... FOR UPDATE SKIP LOCKED` theo thứ tự `created_at`.
2. Relay gửi lên Kafka, chờ xác nhận, rồi ghi `published_at`.
3. Nếu relay chết giữa chừng, sự kiện được gửi lại. Kafka vì thế có thể nhận trùng.
4. Mỗi consumer chèn (`consumer`, `event_id`) vào `processed_events` trong cùng transaction với tác dụng của nó. Trùng khóa nghĩa là đã xử lý, bỏ qua.
5. Sự kiện lỗi quá số lần retry được chuyển sang topic `orders.events.dlq`.

Giao nhận vì vậy là ít nhất một lần ở Kafka và đúng một lần về mặt tác dụng ở consumer.

## 9. Yêu cầu phi chức năng và load test

Tính đúng là yêu cầu tuyệt đối; hiệu năng là mục tiêu để đo và cải thiện. Ngưỡng hiệu năng là điểm khởi đầu, được hiệu chỉnh theo máy chạy thử và ghi rõ trong `docs/benchmarks.md`.

| Tiêu chí | Mục tiêu |
| --- | --- |
| Bán trùng ghế | 0, dưới mọi kịch bản |
| Vi phạm bất biến I1 đến I12 sau load test | 0 |
| Độ trễ giữ vé | p95 dưới 300 ms |
| Độ trễ đọc đêm diễn và sơ đồ ghế | p95 dưới 100 ms |
| Tỷ lệ lỗi 5xx khi tải cao | Dưới 1% |
| Chịu lỗi | Tắt đột ngột một instance API hoặc worker không gây mất đơn, không gây bán trùng |
| Bảo mật | Mật khẩu băm bằng argon2, validate mọi input, xác minh chữ ký IPN |

### Máy đo

Laptop: AMD Ryzen 5 4600H (6 nhân, 12 luồng), 16 GB RAM, Windows 11, Docker Desktop (WSL2, cấp khoảng 7,7 GB RAM). k6 chạy chung máy với hệ thống nên số liệu có nhiễu; mỗi dòng benchmark ghi rõ điều kiện đo và giới hạn CPU của container.

### Kịch bản k6

| Kịch bản | Mô tả | Chứng minh điều gì |
| --- | --- | --- |
| `contention` | 5.000 khách (1.000 VU × 5 lượt) cùng tranh 100 ghế | Không bán trùng (I1) |
| `standing` | 5.000 khách (1.000 VU × 5 lượt) cùng tranh 500 vé khu đứng | Không bán quá sức chứa (I9) |
| `quota` | 20 tài khoản, mỗi tài khoản 50 request giữ vé song song | Không vượt giới hạn mua (I10) |
| `browse` | Đọc danh sách và chi tiết đêm diễn | Hiệu quả của cache |
| `full-flow` | Giữ vé, thanh toán giả lập, nhận vé | Luồng đầy đủ, I2, I7 |
| `webhook-chaos` | IPN gửi trùng, gửi trễ, gửi sau khi đơn hết hạn, sai số tiền | I4, I8, I12 |
| `check-in` | Cùng một mã vé quét đồng thời nhiều lần | I6 |
| `on-sale` | Tải tăng vọt lúc mở bán trên đêm diễn 10.000 vé | Thông lượng, độ trễ, hàng chờ ảo |

Token đăng nhập cho người dùng ảo được tạo sẵn bằng script seed, để phần setup của k6 không phải băm mật khẩu 5.000 lần.

Mọi lần đo chạy qua `pnpm loadtest <kịch bản>`: reset dữ liệu, chạy k6 trong mạng docker compose, kiểm tra bất biến bằng SQL, rồi (với `--record`) thêm một dòng vào `docs/benchmarks.md`. Lý do chọn 1.000 VU × 5 lượt thay vì 5.000 VU: [ADR-0007](adr/0007-load-testing-and-overload.md).

Khi quá tải (pool kết nối DB dùng hết), API trả `503` kèm `Retry-After`, không trả `500`.

Payment provider giả lập có cùng interface với VNPay, bật bằng biến môi trường và chỉ dùng ngoài production.

### Bảng benchmark

Sau mỗi giai đoạn từ 2 trở đi, thêm một dòng vào `docs/benchmarks.md` với các cột: giai đoạn, tag git, cấu hình, kịch bản, số ghế bán trùng, request mỗi giây, p50, p95, p99, tỷ lệ lỗi, ghi chú thay đổi. Bảng này là phần quan trọng nhất của README.

## 10. Lộ trình triển khai

Các giai đoạn làm tuần tự, được gom thành 4 mốc. Hết mỗi mốc là có một phiên bản đủ để đưa vào CV.

| Mốc | Giai đoạn | Nội dung | Tag |
| --- | --- | --- | --- |
| M1: Lõi đặt vé | 0 | Nền móng dự án | `v0-setup` |
| | 1 | Dữ liệu, xác thực, module danh mục | `v0-base` |
| | 2 | Bản đặt vé ngây thơ và baseline | `v0-naive` |
| | 3 | Chống bán trùng ở database | `v1-db-lock` |
| | 4 | Giữ vé có thời hạn, tách worker | `v2-hold` |
| | 5 | Thanh toán, vé, soát vé | `v3-payment` |
| | 6 | Web tối giản và deploy cơ bản | `v3-demo` |
| M2: Mở rộng | 7a | Nhiều instance, WebSocket, cache, rate limit | `v4-scale` |
| | 7b | Đợt mở bán, mã ưu tiên, hàng chờ ảo | `v4-sales` |
| M3: Hướng sự kiện | 8 | Kafka và outbox | `v5-kafka` |
| M4: Vận hành | 9 | Giám sát, CI/CD hoàn chỉnh, README | `v1.0.0` |

### Định nghĩa hoàn thành cho mọi giai đoạn

- `docker compose up` dựng được toàn bộ hệ thống từ máy sạch.
- Format, lint, typecheck và toàn bộ test đều qua trên CI.
- Swagger phản ánh đúng các API hiện có.
- README tiếng Anh và tiếng Việt được cập nhật phần liên quan, trong cùng một commit.
- Có tài liệu text: ghi chú học tập trong `docs/learning/`, và ADR cho các quyết định mới. Đây là tài liệu chính.
- Bổ sung thêm thư mục `docs/showcase/phase-NN/` diễn giải giai đoạn bằng sơ đồ, trang demo gọi API thật, và video tiếng Việt ngắn.
- `docs/learning/` và `docs/showcase/` là tài liệu học riêng của chủ dự án: nằm trong `.gitignore`, chỉ có trên máy, không đẩy lên GitHub.
- Từ giai đoạn 2: có dòng benchmark mới.
- Chủ dự án đã review trước khi gắn tag.

### Giai đoạn 0: Nền móng

- pnpm workspace; NestJS 12 với TypeScript strict, oxlint, Prettier, Vitest.
- Docker Compose với PostgreSQL và Redis; migration chạy tự động trước khi API khởi động.
- Prisma, module cấu hình có validate, Pino, endpoint `/health` và `/health/ready`.
- GitHub Actions chạy format, lint, typecheck, test, e2e và build image.
- `AGENTS.md`, skill tham khảo cho agent, đặc tả này, ADR đầu tiên.

Hoàn thành khi: `docker compose up` chạy được, `/health` trả 200, CI xanh.

### Giai đoạn 1: Dữ liệu, xác thực, module danh mục

- Schema và migration cho `users`, `refresh_tokens`, `concerts`, `performances`, `sale_phases`, `zones`, `seats`, `orders`, `order_items`. Chưa tạo partial unique index và ràng buộc check của khu đứng.
- Đăng ký, đăng nhập, refresh token xoay vòng, đăng xuất, RBAC ba vai trò.
- API tạo và xem concert; tạo, sửa, công bố, xem đêm diễn; API xem ghế và số vé còn lại.
- Định dạng lỗi thống nhất, validate input, Swagger.
- Script seed: 1 concert có 2 đêm diễn, mỗi đêm 10.000 vé (8.000 ghế ngồi chia VIP, CAT 1, CAT 2 và 2.000 vé đứng); 1 đêm diễn thử nhỏ gồm 100 ghế ngồi và 500 vé đứng; 5.000 tài khoản thử kèm token cho load test (ghi ra `load-tests/data/`, không commit).

Hoàn thành khi: e2e test cho auth và danh mục qua, seed chạy dưới 1 phút.

### Giai đoạn 2: Bản ngây thơ và baseline

- `POST /reservations` viết theo cách đơn giản nhất, không khóa, không ràng buộc. Ghế ngồi: đọc ghế, thấy trống thì cập nhật và tạo đơn. Vé đứng: đọc số vé còn lại, thấy đủ thì cộng bộ đếm.
- Kịch bản k6 `contention`, `standing` và `browse`.
- Script kiểm tra I1 và I9 trong `load-tests/verify/`.
- `pnpm loadtest` và skill `/benchmark`: chạy k6, chạy script kiểm tra và thêm dòng vào `docs/benchmarks.md`.
- `GET /orders`, `GET /orders/:id` để khách xem đơn của mình.

Hoàn thành khi: load test cho thấy có ghế bị bán trùng và con số được ghi lại. Nếu không tái hiện được lỗi, tăng số người dùng ảo cho đến khi thấy. Gắn tag `v0-naive` trước khi sửa lỗi này.

### Giai đoạn 3: Chống bán trùng ở database

- Thêm partial unique index trên `order_items` và ràng buộc check trên `zones`.
- Viết lại giữ ghế ngồi bằng transaction; so sánh ba cách khóa ở luồng A bước 5 (`SEAT_HOLD_STRATEGY`).
- Viết lại giữ vé đứng bằng câu `UPDATE` có điều kiện; đo hot row, thử chia bộ đếm.
- Thêm `Idempotency-Key`, kể cả trường hợp hai request cùng key đến song song.
- Thêm giới hạn mua mỗi tài khoản bằng advisory lock; kịch bản k6 `quota`.

Hoàn thành khi: kịch bản `contention` cho 0 ghế bán trùng qua 5 lần chạy liên tiếp; `standing` và `quota` không tạo vi phạm; có test tự động cho I1, I5, I9, I10.

### Giai đoạn 4: Giữ vé có thời hạn

- Giữ chỗ trong Redis bằng Lua script, đặt trước bước ghi database.
- Đơn có `expires_at`; job `expire-order`, `sweep-expired` và `reconcile-standing`.
- Tách tiến trình worker (`worker.ts`).
- API hủy đơn.

Hoàn thành khi: test chứng minh ghế tự về `AVAILABLE` sau khi hết hạn, kể cả khi worker bị tắt và bật lại giữa chừng (I3); benchmark so sánh với giai đoạn 3. Nếu Redis không cải thiện số liệu, README ghi rõ điều đó.

### Giai đoạn 5: Thanh toán, vé, soát vé

- Interface payment provider, bản giả lập và bản VNPay sandbox (chỉnh từ code có sẵn của chủ dự án).
- IPN có xác minh chữ ký, kiểm tra số tiền, idempotent; thời gian ân hạn thanh toán.
- State machine đơn hàng đầy đủ, gồm luồng hoàn tiền qua BullMQ có DLQ.
- Hủy đêm diễn và hoàn tiền hàng loạt.
- Phát hành vé kèm mã QR; API check-in.
- Kịch bản k6 `full-flow`, `webhook-chaos`, `check-in`.

Hoàn thành khi: có test tự động cho I2, I4, I6, I8, I12; kịch bản `webhook-chaos` không tạo vi phạm nào.

### Giai đoạn 6: Web tối giản và deploy cơ bản

- `apps/web` bằng Next.js: danh sách concert, sơ đồ ghế (react-konva), chọn vé đứng, thanh toán, vé QR. Kiểu dữ liệu sinh từ Swagger.
- Test Playwright cho luồng mua vé.
- Deploy cơ bản lên một VPS bằng Docker Compose để có link demo.

Hoàn thành khi: mua được vé trên bản demo online bằng tài khoản thử.

### Giai đoạn 7a: Mở rộng

- Nginx với 2 instance API; kiểm tra lại toàn bộ bất biến trên nhiều instance.
- WebSocket Gateway với Redis adapter; sơ đồ ghế realtime theo cơ chế bản chụp kèm `seq`.
- Cache cho API đọc concert và đêm diễn, có xóa cache khi sửa.
- Rate limiting lưu trong Redis.

Hoàn thành khi: hai trình duyệt nối vào hai instance khác nhau cùng thấy ghế đổi trạng thái (test bằng Playwright); tắt một instance giữa lúc load test không gây vi phạm bất biến.

### Giai đoạn 7b: Mở bán

- Đợt mở bán và mã ưu tiên.
- Hàng chờ ảo.
- Kịch bản k6 `on-sale`.

Hoàn thành khi: có test tự động cho I11; kịch bản `on-sale` có số liệu và không có vi phạm.

### Giai đoạn 8: Kafka và outbox

- Kafka một node chế độ KRaft trong Docker Compose.
- Bảng `outbox_events`, ghi sự kiện trong transaction của luồng B, luồng C và luồng hủy đêm diễn.
- Outbox relay trong worker.
- Ba consumer: `notifications`, `analytics`, `audit`, đều idempotent qua `processed_events`; topic dead letter.
- Email vé gửi qua consumer `notifications` (Mailpit ở local).
- Trang theo dõi mở bán trong `apps/web`, nhận `sales.updated`.

Hoàn thành khi: test chứng minh I7 trong ba tình huống: relay bị tắt giữa chừng, Kafka tạm ngừng rồi chạy lại, một sự kiện bị gửi hai lần.

### Giai đoạn 9: Vận hành

- Metrics Prometheus và dashboard Grafana cho thông lượng, độ trễ, độ dài queue, độ trễ consumer.
- CI build image, đẩy lên GitHub Container Registry, deploy qua SSH, HTTPS bằng Let's Encrypt.
- README hoàn chỉnh.

Hoàn thành khi: bản demo online chạy đầy đủ, README có sơ đồ kiến trúc, bảng benchmark và ảnh dashboard.

## 11. Triển khai và README

Bản online chỉ để demo chức năng; mọi số liệu load test được đo ở local bằng Docker Compose.

### Triển khai

- Một VPS chạy toàn bộ bằng Docker Compose.
- Không build trên VPS. GitHub Actions build image, đẩy lên GitHub Container Registry; VPS chỉ kéo image về chạy.
- Mỗi container có giới hạn bộ nhớ trong file Compose.
- Migration chạy tự động trước khi container API mới nhận request.
- Secret đặt trong biến môi trường trên server và GitHub Secrets.

### README phải có

README có hai bản: `README.md` (tiếng Anh) và `README.vi.md` (tiếng Việt), nội dung giống nhau.

- Bài toán và lý do nó khó, trong vài câu.
- Sơ đồ kiến trúc.
- Bảng benchmark qua các giai đoạn, bắt đầu từ bản bán trùng.
- Giải thích từng quyết định chính và phương án đã loại, liên kết sang `docs/adr/`.
- Bảng phân vai BullMQ và Kafka.
- Cách chạy bằng một lệnh, cách chạy load test.
- Link demo, tài khoản thử, link Swagger.
- Ảnh dashboard Grafana lúc load test.
- Giới hạn đã biết và hướng cải tiến.

## 12. Quyết định còn mở

| Điểm | Hiện tại | Cần chốt trước giai đoạn |
| --- | --- | --- |
| Code VNPay | Chủ dự án cung cấp từ dự án ecommerce | 5 |
| Dịch vụ gửi email production | Chưa chọn; ở local dùng Mailpit | 8 |
| Cấu hình VPS và tên miền | Chưa có | 6 |
