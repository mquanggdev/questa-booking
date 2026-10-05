# ADR-0009: Idempotency-Key và giới hạn vé mỗi tài khoản

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-05
- Giai đoạn: 3

## Bối cảnh

Có hai quy tắc trải rộng trên **nhiều đơn hàng**, nên khóa từng ghế không đủ để bảo vệ chúng:

- **I5:** gửi lại một request (mạng chập chờn, người dùng bấm hai lần) không được tạo đơn thứ hai.
- **I10:** một tài khoản không giữ và mua quá `max_tickets_per_user` vé của một đêm diễn, kể cả khi gửi nhiều request song song.

Với I10, cách ngây thơ "đếm số vé đang có, nếu chưa đủ thì tạo đơn" lại là check-then-act: 8 request song song cùng đếm thấy 0, và cả 8 cùng được tạo.

## Quyết định

1. **Header `Idempotency-Key` là bắt buộc** với `POST /reservations` (1–100 ký tự `A-Z a-z 0-9 _ . : -`). Bảng `orders` có unique `(user_id, idempotency_key)`, và lưu `request_hash` (SHA-256 của request đã chuẩn hóa).
2. **Mỗi transaction đặt vé bắt đầu bằng `pg_advisory_xact_lock`**, khóa trên hash 64-bit của chuỗi `user_id:performance_id`. Các request của **cùng một khách cho cùng một đêm diễn** chạy lần lượt; request của khách khác thì không bao giờ phải chờ.
3. **Trong khóa đó**, theo thứ tự:
   - **Đã có đơn với key này?** Cùng `request_hash` thì trả lại đơn cũ (201, header `Idempotent-Replayed: true`). Khác `request_hash` thì trả `422 IDEMPOTENCY_KEY_REUSED`.
   - **Đếm vé đang có** (đơn `PENDING` và `PAID`, item chưa nhả). Nếu cộng với số vé đang yêu cầu mà vượt giới hạn thì trả `409 TICKET_LIMIT_REACHED`.
4. **Khóa tự nhả khi commit hoặc rollback.** Không cần bảng khóa riêng, và không có khóa nào bị kẹt lại.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| `SELECT ... FOR UPDATE` trên dòng `users` | Cũng tuần tự hóa được, nhưng khóa luôn cả người dùng trên **mọi** đêm diễn, và đụng vào bảng của module khác |
| Lưu key trong Redis với TTL | Redis không phải nguồn sự thật; mất Redis thì mất tính idempotent. Thêm nữa, key và đơn hàng không được ghi trong cùng một transaction |
| Chỉ dựa vào unique `(user_id, key)` | Request gửi lại đồng thời sẽ đụng unique index **sau khi** đã giữ ghế. Request thua thường nhận `409 SEAT_UNAVAILABLE` thay vì nhận lại đơn của chính mình. Advisory lock khiến request thua đợi request thắng commit, rồi tìm thấy đơn và trả lại nó |
| Không bắt buộc key | Client quên gửi key thì mất bảo vệ đúng lúc cần nhất: khi mạng chập chờn và người dùng bấm lại |

## Hệ quả

- **Đã kiểm chứng:**
  - 6 request đồng thời cùng một key tạo đúng 1 đơn.
  - 8 request song song của một tài khoản (giới hạn 4) thì đúng 4 request thành công.
  - Kịch bản k6 `quota` (20 tài khoản × 50 request song song) cho đúng 6 vé mỗi người, tổng 120.
- **Chỉ đơn thành công mới gắn với key.** Request thất bại (ví dụ ghế đã hết) không lưu kết quả, nên thử lại cùng key sẽ chạy lại từ đầu. Đây là hành vi chấp nhận được với việc giữ vé.
- **Cùng key nhưng cho đêm diễn khác** sẽ dùng advisory lock khác. Trường hợp này được unique index bắt và trả `422`.
