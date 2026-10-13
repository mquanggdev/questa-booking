# Questa Booking

[English](README.md) | **Tiếng Việt** &nbsp; [![CI](https://github.com/mquanggdev/questa-booking/actions/workflows/ci.yml/badge.svg)](https://github.com/mquanggdev/questa-booking/actions/workflows/ci.yml)

Backend bán vé concert, được xây để bán đúng số ghế đang có khi hàng nghìn người cùng mua một lúc, và chứng minh điều đó bằng số liệu.

> **Trạng thái:** Xong giai đoạn 8: mỗi thay đổi của đơn hàng ghi sự kiện vào bảng outbox trong cùng transaction; relay gửi sự kiện lên Kafka, và ba consumer (email vé kèm mã QR, thống kê bán vé, nhật ký audit) áp dụng mỗi sự kiện đúng một lần, đã chứng minh khi relay chết, khi Kafka tạm ngừng và khi một sự kiện đến hai lần. Các giai đoạn trước: chống bán trùng ở database, bộ lọc Redis, vé tự hết hạn, thanh toán qua IPN có chữ ký và hoàn tiền, trang web Next.js, 2 instance API sau Nginx với sơ đồ ghế realtime, mã ưu tiên và hàng chờ ảo. Bản demo online có ở giai đoạn 9.

![Mua vé: đăng ký, chọn ghế và vé đứng, giữ vé, thanh toán ở cổng giả lập, nhận vé QR](docs/assets/buying-flow.gif)

## Bài toán

Đợt mở bán vé là những đợt truy cập ngắn và dồn dập, khi rất nhiều người cùng muốn vài ghế giống nhau. Cách làm ngây thơ "đọc ghế, thấy trống, rồi ghi" sẽ bán một ghế cho hai người khi tải cao.

Dự án bắt đầu từ đúng phiên bản lỗi đó, đo số ghế bị bán trùng, rồi loại bỏ lỗi từng bước: khóa ở database, giữ vé có thời hạn bằng Redis, thanh toán idempotent, chạy nhiều instance, hàng chờ ảo, và phát sự kiện qua Kafka. Mỗi bước đều có benchmark.

## Công nghệ

NestJS 12 (TypeScript, ESM) · PostgreSQL 18 · Prisma 7 · Redis 8 · BullMQ · Kafka · Socket.IO · Next.js · k6 · Docker Compose · GitHub Actions · Prometheus và Grafana

Lý do có mặt của từng công nghệ: [`docs/adr/`](docs/adr/).

## Chạy thử

Cần có: Docker, Node.js 24, pnpm.

```bash
cp .env.example .env
docker compose up -d --build
curl localhost:3000/api/v1/health/ready
```

`docker compose up` khởi động PostgreSQL, Redis, Kafka và Mailpit, chạy migration, rồi khởi động 2 instance API, tiến trình worker chạy nền và trang web, tất cả sau Nginx, cửa vào duy nhất (`/` sang trang web, `/api` và `/socket.io` sang các instance API).

- Trang web: <http://localhost:3200>. Chọn đêm diễn, chọn ghế trên sơ đồ, giữ vé, thanh toán ở cổng giả lập, nhận vé QR. Ghế người khác vừa giữ hoặc mua đổi màu ngay. Mỗi response ghi instance đã xử lý trong header `X-Instance`.
- Sau khi seed: "Questa Arena Live" (10.000 vé) bán qua hàng chờ ảo, còn "Questa Fan Club Night" đang trong đợt bán trước; 50 mã ưu tiên của nó được ghi vào `load-tests/data/fixtures.json`.

Mặc định thanh toán dùng cổng giả lập chạy cục bộ (`PAYMENT_PROVIDER=fake`), nên không cần tài khoản nào. Muốn trả tiền trên VNPay sandbox thật, xem [`docs/vnpay-sandbox.md`](docs/vnpay-sandbox.md).

- Ban tổ chức theo dõi mở bán trực tiếp ở `/performances/<id>/sales` (đăng nhập bằng `organizer@questa.test`).
- Email (vé kèm mã QR, hủy đêm diễn, hoàn tiền) được gửi tới Mailpit, một hộp thư chạy ở máy: <http://localhost:8025>.
- Tài liệu API (Swagger): <http://localhost:3000/api/docs>
- Nạp dữ liệu mẫu (xóa sạch database dev):

  ```bash
  pnpm install
  pnpm --filter @questa/api db:seed
  ```

  Tài khoản: `organizer@questa.test`, `staff@questa.test`, `customer0001@questa.test` … `customer5000@questa.test`, mật khẩu là giá trị `SEED_PASSWORD` trong `.env.example`.

### Phát triển trên máy

```bash
pnpm install
docker compose up -d postgres redis
pnpm --filter @questa/api start:dev
pnpm --filter @questa/web dev        # http://localhost:3200
```

| Lệnh | Việc |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Kiểm tra tĩnh |
| `pnpm test` | Unit test |
| `pnpm test:e2e` | E2E test trên database riêng `questa_test` và topic Kafka riêng (cần PostgreSQL, Redis, Kafka và Mailpit) |
| `pnpm test:browser` | Test Playwright luồng mua vé trên trình duyệt thật (cần stack đang chạy, đã seed, và `RATE_LIMIT_ENABLED=false`) |

## Benchmark

Mọi con số đều từ `pnpm loadtest <kịch bản>`: k6 chạy trong mạng docker compose, sau đó kiểm tra bằng SQL thẳng vào PostgreSQL. Bảng đầy đủ: [`docs/benchmarks.md`](docs/benchmarks.md).

| Giai đoạn | Kịch bản | Kết quả |
| --- | --- | --- |
| 2: ngây thơ "đọc, kiểm tra, ghi" | 5.000 khách, 100 ghế | **4–11 ghế bị bán hai lần**, ở mọi lần chạy |
| 2: ngây thơ | 5.000 khách, 500 vé đứng | **Phát 925 vé** cho 500 chỗ; bộ đếm chỉ ghi 94 (mất 831 lần cập nhật) |
| 2: ngây thơ | đọc danh mục, một tiến trình API | 100 req/s với p95 41 ms; bão hòa (hết CPU) trước 200 req/s |
| **3: bảo vệ ở database** | 5.000 khách, 100 ghế | **0 ghế bán trùng qua 5 lần chạy liên tiếp**, đúng 100 vé |
| 3 | 5.000 khách, 500 vé đứng | đúng **500** vé, bộ đếm khớp |
| 3 | 20 tài khoản × 50 request song song, giới hạn 6 | đúng **6 vé mỗi tài khoản** (tổng 120) |
| 3 | so sánh 3 cách khóa ghế | đều đúng, chênh nhau khoảng 10% (đã đo lại, xem dưới) ([ADR-0008](docs/adr/0008-seat-and-standing-locking.md)) |
| **4: bộ lọc Redis tắt → bật** | 5.000 khách, 100 ghế | 159–211 → **701–815 req/s**, p50 ~5 s → **11–456 ms**, lỗi 503 → **0**; vẫn 0 ghế bán trùng |
| 4 | 5.000 khách, 500 vé đứng | ~200 → **~510 req/s**, p50 ~4,5 s → **~25 ms** |
| **5: thanh toán** | IPN hỗn loạn: mỗi IPN gửi 5 lần song song, sai số tiền, chữ ký giả, tiền về sau khi đơn đã hủy, hủy đơn đua với IPN | **0 vi phạm** I2/I4/I8/I9/I12; 500 thanh toán được xác nhận đúng một lần, 250 đơn được hoàn tiền |
| 5 | 5.000 khách: giữ vé → thanh toán → nhận vé | cả 500 vé đã giữ đều được thanh toán và phát vé, 0 vi phạm; khoảng 6% lượt giữ vé nhận 503 khi quá tải |
| 5 | 5.000 lượt quét đồng thời trên 100 vé | đúng **100 lượt được nhận**; 267 → **365 req/s** sau khi gộp lượt quét thành công vào một câu lệnh |
| **7a: 1 → 2 instance API sau Nginx** | 5.000 khách, 100 ghế | 525 → **790 req/s**, p95 7,3 s → 4,8 s; vẫn 0 ghế bán trùng |
| 7a | 5.000 khách, 500 vé đứng | 436 → **614 req/s**; đúng 500 vé |
| 7a | giết một instance (`docker kill`) ở giây thứ 5 | **0 vi phạm bất biến** ở cả hai kịch bản; chỉ các request đang dở trên instance chết bị lỗi |
| 7a: cache danh mục tắt → bật | đọc danh mục 400 req/s | chỉ theo được 362 req/s, p95 4,9 s → **400 req/s, p95 7 ms** |
| **7b: mở bán 10.000 vé** | 4.000 khách vào hàng chờ trước giờ mở; 5% cố lách hàng | hàng chờ cho vào **50 người/s**: giữ vé p50 **20 ms**, p95 **99 ms**, 0 lỗi, **0 trên 114** lượt lách hàng lọt qua |
| 7b | cùng cú dồn tải, cho vào 100 người/s | vượt sức chứa trên máy này: giữ vé p50 3,7 s, có 503 (pool DB cạn). Tốc độ cho vào được đặt theo số đo |
| 7b | cùng cú dồn tải, **không hàng chờ** | giữ vé p95 **10,7 s**, 16% request lỗi 503; vẫn 0 vi phạm bất biến |
| **8: outbox + Kafka** | 5.000 khách: giữ vé → thanh toán → nhận vé, rồi chờ sự kiện xử lý xong | 500 sự kiện `order.paid`, mỗi sự kiện được cả 3 consumer áp dụng **đúng một lần** (**0 vi phạm I7**), audit và thống kê khớp; thông lượng như giai đoạn 5 |
| 8 | giết worker (relay + consumer) ở giây thứ 8 | sau khi khởi động lại, mọi sự kiện vẫn được áp dụng đúng một lần: **0 vi phạm** |
| 7b | lần chạy mở bán đầu tiên, trước khi sửa | 28.457 lỗi 502: hàng đợi kết nối của Node tràn, và lỗi đua keep-alive khiến Nginx đánh dấu cả 2 instance khỏe là chết ([ADR-0016](docs/adr/0016-presale-codes-and-waiting-room.md)) |

> Một lỗi đo (`docker compose run` âm thầm tạo lại API với cấu hình mặc định) đã làm sai ba phép so sánh trước đó. Script load test giờ ghi lại cấu hình thật của API cùng mỗi kết quả; các dòng bị ảnh hưởng đã được đánh dấu và đo lại ([ADR-0011](docs/adr/0011-benchmark-config-integrity.md)).

```bash
pnpm --filter @questa/api db:seed
pnpm loadtest contention      # hoặc: standing, quota, browse, full-flow, webhook-chaos, check-in, on-sale
```

## Tài liệu

- [Đặc tả](docs/spec.md)
- [Các quyết định kiến trúc (ADR)](docs/adr/)
- [Thanh toán trên VNPay sandbox](docs/vnpay-sandbox.md)

## Giấy phép

[MIT](LICENSE)
