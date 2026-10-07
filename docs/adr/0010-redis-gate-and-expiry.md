# ADR-0010: Bộ lọc Redis trước database, giữ vé có thời hạn, và tiến trình worker

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-07
- Giai đoạn: 4

## Bối cảnh

Sau giai đoạn 3, hệ thống đã đúng nhưng còn chậm khi tải cao. Có 5.000 khách tranh 100 ghế, nên 4.900 người chắc chắn sẽ thua. Mỗi người thua vẫn chiếm một kết nối DB và mở một transaction chỉ để được báo "ghế đã hết". Kết quả: khoảng 200 req/s, p50 khoảng 5 giây, hàng nghìn lỗi 503.

Ngoài ra, vé đang giữ phải **tự nhả** sau 10 phút nếu khách không thanh toán, kể cả khi tiến trình xử lý nền đang tắt (I3).

## Quyết định

### 1. Bộ lọc Redis ("cổng giữ vé")

Mỗi request giữ vé đi qua một script Lua trên Redis **trước mọi truy vấn DB**. Script này nguyên tử: hoặc giữ được tất cả, hoặc không giữ gì.

| Key | Nghĩa |
| --- | --- |
| `seat:hold:<seatId>` | Ghế đang được giữ. TTL ngắn (khoảng 17 giây) trong lúc DB đang chạy transaction, rồi kéo dài bằng thời gian giữ + ân hạn + 60 giây sau khi commit |
| `zone:avail:<zoneId>` | Số vé đứng còn lại. Tạo từ PostgreSQL ở lần dùng đầu tiên (`SET NX`) |
| `zone:inflight:<zoneId>` | Sorted set đánh dấu các lượt giữ chưa commit, kèm thời điểm bắt đầu |
| `hold:req:<user>:<key>` | Request (theo Idempotency-Key) đang chạy hoặc đã commit. Request gửi lại thấy key này thì bị coi là `DUPLICATE` và đi thẳng xuống DB để nhận lại đơn cũ |

Luồng xử lý:
- Redis từ chối (ghế đã bị giữ, khu hết vé) thì trả `409` ngay, không chạm DB.
- Redis cho qua thì PostgreSQL vẫn là nơi quyết định cuối cùng, với các bảo vệ của [ADR-0008](0008-seat-and-standing-locking.md).
- DB thất bại thì Redis được hoàn tác (rollback). DB thành công thì Redis được xác nhận (commit).

**Redis không phải nguồn sự thật.** Mọi cách Redis có thể sai lệch đều được thiết kế để lệch về phía **cho qua nhiều hơn**, vì PostgreSQL vẫn chặn được:

| Sự cố | Hậu quả | Tự hồi phục bằng |
| --- | --- | --- |
| Redis không truy cập được | Bỏ qua bộ lọc, mọi request xuống DB (fail-open) | — |
| Redis mất dữ liệu | Bộ lọc cho qua; DB chặn bán trùng | Bộ đếm được dựng lại từ DB ở lần dùng tiếp theo |
| Tiến trình chết sau khi giữ ở Redis, trước khi tới DB | Ghế bị bộ lọc chặn oan trong khoảng 17 giây | TTL ngắn tự hết |
| Tiến trình chết trước khi hoàn tác bộ đếm vé đứng | Bộ đếm thấp hơn thực tế | Job `reconcile-standing` (mỗi 30 giây) sửa lại, chỉ khi khu không có lượt giữ nào đang chạy |

### 2. Giữ vé có thời hạn (luồng C)

- **Đơn `PENDING` có `expires_at`** bằng thời điểm tạo + 10 phút. Sau đó còn **2 phút ân hạn** (`PAYMENT_GRACE_SECONDS`) để khoản thanh toán về trễ ở giai đoạn 5 vẫn tìm thấy đơn.
- **Nhả vé** là một transaction: `UPDATE orders ... WHERE status = 'PENDING' AND expires_at + ân hạn <= now()`, ghi `released_at` cho các item, trả ghế về `AVAILABLE`, giảm `held_count`. Câu `UPDATE` có điều kiện nên job hết hạn, job quét, lệnh hủy và (giai đoạn 5) thanh toán có chạy đua nhau thì cũng chỉ một bên thắng.
- **Ba lớp đảm bảo vé được nhả (I3):**
  1. **Delayed job `expire-order`** chạy đúng lúc hết hạn. `jobId = expire-<orderId>`, nên không bao giờ tạo hai job cho một đơn.
  2. **Job `sweep-expired` chạy mỗi phút**, nhả các đơn quá hạn mà job của nó đã mất (ví dụ Redis sập đúng lúc tạo đơn).
  3. **BullMQ lưu job trong Redis.** Job đến hạn lúc worker đang tắt vẫn nằm chờ, và được xử lý ngay khi worker chạy lại.
- **`POST /orders/:id/cancel`:** chủ đơn hủy đơn `PENDING`, vé được nhả ngay.

### 3. Tiến trình worker riêng

- `worker.ts` dùng **cùng image Docker** với API, chỉ khác lệnh khởi động (`node dist/worker.js`).
- Worker chạy các BullMQ processor, không mở cổng HTTP. Việc nền không tranh CPU với request của người dùng.
- Lịch chạy định kỳ được đăng ký bằng `upsertJobScheduler`. Hàm này idempotent: worker khởi động lại nhiều lần cũng không tạo lịch trùng.

## Kết quả đo

Cùng code, chỉ khác cờ `RESERVATION_GATE_ENABLED`. Cấu hình được đọc từ container ([ADR-0011](0011-benchmark-config-integrity.md)).

| Kịch bản (5.000 lượt, 1.000 VU) | Bộ lọc tắt | Bộ lọc bật |
| --- | --- | --- |
| `contention` (100 ghế) | 159–211 req/s, p50 4,1–5,3 s, 150–2.457 lỗi 503 | **701–815 req/s, p50 11–456 ms, 0 lỗi 503** |
| `standing` (500 vé) | 190–208 req/s, p50 4,3–4,8 s, khoảng 3.000 lỗi 503 | **khoảng 510 req/s, p50 23–28 ms**, 427–696 lỗi 503 |

Mọi lần đo đều 0 vi phạm I1, I9, I10.

**Thông lượng tăng khoảng 4 lần.** Người thua giờ được trả lời bằng một lần gọi Redis, thay vì 2 truy vấn và 1 transaction ở DB.

Ở `standing` vẫn còn lỗi 503: 500 request thắng vẫn phải tranh nhau một dòng `zones` (hot row). Phần này để hàng chờ ảo ở giai đoạn 7b xử lý.

## Một sai lầm trong lúc làm

Bản đầu tiên kiểm tra Idempotency-Key **trước** bộ lọc, bằng một truy vấn DB thường. Bước này có hai tác dụng ngoài ý muốn:
- **Người thua vẫn phải chạm DB.** Bộ lọc gần như không có tác dụng.
- **Lỗi 503 biến thành thời gian chờ dài.** Truy vấn thường không bị giới hạn 2 giây chờ kết nối như transaction, nên request xếp hàng ở đó thay vì bị từ chối.

Cách sửa: đưa bộ lọc lên đầu tiên. Request gửi lại được nhận ra nhờ key `hold:req`, vốn được giữ lại sau khi commit.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Redis là nguồn sự thật (DB chỉ lưu sau) | Mất Redis là mất dữ liệu hoặc bán trùng. Đặc tả quy định PostgreSQL là nguồn sự thật |
| Fail-closed khi Redis lỗi (từ chối mọi request) | Một sự cố Redis làm ngừng toàn bộ việc bán vé, dù DB vẫn tự bảo vệ được |
| Chỉ dùng TTL của Redis để hết hạn vé | Redis hết TTL không làm thay đổi DB. Ghế vẫn `HELD` trong DB; vẫn phải có job nhả vé |
| Cron ở tầng ứng dụng (setInterval) | Chạy nhiều instance thì cron chạy trùng; dừng tiến trình thì mất lịch. BullMQ lưu lịch trong Redis |
| Nhả vé ngay trong tiến trình API | Việc nền tranh CPU với request của người dùng, đúng lúc API đang là nút thắt (ADR-0008) |

## Hệ quả

- **Test chứng minh I3:** job đến hạn lúc chưa có worker nào chạy vẫn được xử lý khi worker khởi động; job quét nhả được các đơn mà job của chúng đã bị xóa.
- **`load-tests/run.mjs` reset cả key của bộ lọc** (không đụng tới key `bull:*` của BullMQ), để mỗi lần đo bắt đầu như nhau.
- **Thêm một service `worker` trong docker-compose.** Docker cần thêm khoảng 100 MB RAM.
