# ADR-0012: Thanh toán qua IPN, hoàn tiền bằng BullMQ, hủy đêm diễn và soát vé

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-08
- Giai đoạn: 5

## Bối cảnh

Đến giai đoạn 4, khách giữ được vé nhưng chưa trả tiền được. Giai đoạn 5 phải nhận tiền từ cổng thanh toán (VNPay sandbox), phát vé, hoàn tiền khi cần và soát vé ở cổng. Ở đây "đúng" quan trọng hơn mọi thứ khác: không bán trùng, **không mất tiền của khách**.

Cổng thanh toán là một hệ thống bên ngoài, gây ra những tình huống mà code bình thường hiếm gặp:

- IPN (Instant Payment Notification, cổng gọi về server) có thể đến **nhiều lần**, đến **cùng lúc**, hoặc đến **muộn** sau khi đơn đã hết hạn.
- Ai cũng gọi được URL IPN, nên nội dung giả mạo hoặc sai số tiền là chuyện phải tính tới.
- VNPay coi mọi câu trả lời khác `00`/`02` là "chưa nhận được" và **gửi lại** (tối đa 10 lần trong 5 phút).
- Trình duyệt quay về Return URL với cùng tham số đã ký, nhưng khách có thể đóng tab trước khi tới đó.

## Quyết định

### 1. Giao diện provider, và một cổng giả lập nói cùng giao thức

`PaymentProvider` có ba việc: tạo URL thanh toán, đọc callback đã xác minh chữ ký, và yêu cầu hoàn tiền. Có hai bản cài đặt:

- `vnpay`: VNPay 2.1.0, viết lại theo tài liệu chính thức. Các tham số được sắp xếp, mã hóa bằng `encodeURIComponent` (dấu cách thành `+`) rồi ký HMAC-SHA512. Số tiền nhân 100, giờ theo GMT+7. `vnp_ExpireDate` bằng `expires_at` của đơn, để cổng không nhận tiền sau khi hết giờ giữ vé. Code cũ của chủ dự án chỉ dùng Return URL và thiếu IPN, hoàn tiền và hạn thanh toán, nên chỉ dùng để tham khảo.
- `fake`: cổng giả lập chạy ngay trong API, **nói đúng giao thức VNPay** (cùng tham số, cùng cách ký) nhưng với secret riêng. Test, load test và trang demo dùng cổng này, nên không phụ thuộc sandbox thật. Trong môi trường production, cổng giả lập bị từ chối lúc khởi động, trừ khi đặt rõ `ALLOW_FAKE_PAYMENTS=true` (dùng cho stack Docker cục bộ).

Cổng giả lập **gửi lại IPN giống VNPay**: khi câu trả lời khác `00`/`02`, nó gửi lại tối đa 5 lần, có backoff. Chi tiết này được thêm sau khi load test cho thấy nó cần thiết (xem mục Hệ quả).

### 2. IPN là nguồn sự thật duy nhất; Return URL chỉ để hiển thị

`GET /payments/ipn/:provider` luôn trả HTTP 200 kèm `RspCode` của VNPay. Các bước kiểm tra theo đúng thứ tự sau, và chưa đọc hay ghi gì trước khi chữ ký hợp lệ:

| Bước | Sai thì trả | Bất biến |
| --- | --- | --- |
| Chữ ký HMAC (so sánh bằng `timingSafeEqual`) | `97` | |
| Tìm payment theo `vnp_TxnRef` | `01` | |
| Số tiền bằng số tiền của payment (chính là `total_amount`) | `04` | I12 |
| Payment còn `PENDING` (chưa được xử lý) | `02` | I4 |
| Cổng báo thất bại: payment sang `FAILED`, đơn vẫn `PENDING` để trả lại | `00` | |
| Thành công: transaction ở mục 3 | `00` hoặc `02` | I2, I4, I8 |
| Lỗi bất ngờ (ví dụ hết kết nối DB) | `99`, để VNPay gửi lại | |

`GET /payments/return/:provider` chỉ xác minh chữ ký và **báo** trạng thái hiện tại của đơn. Nó không bao giờ đổi trạng thái đơn.

### 3. Một transaction cho thanh toán thành công

```text
UPDATE payments SET status='SUCCEEDED', provider_txn_id=... WHERE id=... AND status='PENDING'   -- I4
SELECT ... FROM orders WHERE id=... FOR UPDATE              -- khóa đơn
SELECT status FROM performances WHERE id=... FOR SHARE      -- đêm diễn chưa bị hủy
nếu đơn PENDING, đêm diễn chưa hủy và còn trong hạn + ân hạn:
    đơn -> PAID; ghế HELD -> SOLD (đếm đủ số ghế, thiếu thì rollback);
    phát vé; cuối cùng mới chuyển bộ đếm vé đứng held -> sold
ngược lại:
    nếu đơn còn PENDING: đóng đơn (EXPIRED, hoặc CANCELLED nếu đêm diễn đã hủy) và nhả vé
    đơn EXPIRED/CANCELLED -> REFUND_PENDING; tạo một dòng refunds cho payment này     -- I8
```

- **I4** được giữ ở hai lớp. Câu `UPDATE` có điều kiện bảo đảm hai bản sao của cùng một IPN đến cùng lúc chỉ có một bản khớp; bản còn lại phải chờ dòng bị khóa, rồi không khớp gì nữa. Unique `provider_txn_id` thì chặn một giao dịch của cổng bị áp dụng cho payment thứ hai.
- **Thứ tự khóa** luôn là đơn rồi đến đêm diễn. Hủy đêm diễn cần khóa ghi trên dòng đêm diễn, nên phải chờ mọi thanh toán đang chạy, và ngược lại. Hai việc không bao giờ đan xen.
- **Hết hạn và thanh toán bổ sung cho nhau, không chồng lên nhau.** Điều kiện hết hạn là `expires_at + ân hạn <= now()`, điều kiện thanh toán là `> now()`. Trong cùng một transaction, `now()` là một giá trị cố định, nên đơn rơi vào đúng một trong hai trường hợp.
- **Một đơn có thể có nhiều payment.** Mỗi lần bấm "Thanh toán" tạo một `txnRef` mới, vì VNPay yêu cầu mỗi giao dịch một mã riêng. Nếu khách trả tiền hai lần, payment đến trước làm đơn `PAID`. Payment đến sau được hoàn tiền, còn đơn vẫn `PAID`.

### 4. Hoàn tiền: dòng `refunds` là nguồn sự thật, BullMQ chỉ để thực thi

- Dòng `refunds` được tạo **trong cùng transaction** với quyết định hoàn tiền. Job `refund` chỉ mang `refundId`, với `jobId = refund-<id>` để không tạo trùng. Job chạy tối đa `REFUND_MAX_ATTEMPTS` lần (mặc định 5), backoff lũy thừa bắt đầu từ 1 giây.
- Cổng từ chối hẳn (`PermanentRefundError`) thì ném `UnrecoverableError`, để BullMQ dừng retry ngay. Ở lần thử cuối, hoặc khi bị từ chối hẳn, refund chuyển sang `FAILED`, kèm `last_error`, và có một bản sao trong queue `payments-dead-letter` để người vận hành xử lý.
- Job `sweep-payments` chạy định kỳ. Refund còn `PENDING` mà quá 60 giây không tiến triển thì được đưa vào queue lại; nếu job của nó đã thất bại mà chưa kịp ghi nhận thì ghi `FAILED`. Đêm diễn đã hủy mà còn đơn chưa xử lý thì chạy lại job hủy.
- Đơn chuyển `REFUNDED` khi **mọi** refund của đơn đã thành công.

### 5. Hủy đêm diễn

`POST /performances/:id/cancel` đổi trạng thái bằng câu `UPDATE` có điều kiện. Từ lúc đó, việc giữ vé và tạo thanh toán mới bị từ chối. API rồi đưa job `cancel-performance` vào queue; worker xử lý **từng đơn trong một transaction ngắn**, theo lô 200 đơn:

- Đơn `PENDING` chuyển `CANCELLED` và được nhả vé.
- Đơn `PAID` chuyển `REFUND_PENDING`. Trong cùng transaction: ghi `released_at` cho các dòng của đơn, ghế `SOLD` về `AVAILABLE`, `sold_count` giảm, vé bị **vô hiệu ngay**, và mỗi payment đã thành công có một refund.

Điểm này **lệch khỏi đặc tả ban đầu**: bản đầu ghi rằng vé bị vô hiệu khi hoàn tiền xong. Lý do đổi:

1. Một vé của buổi diễn đã hủy không được phép quét qua cổng trong lúc chờ cổng thanh toán.
2. I2 ("ghế `SOLD` bằng số dòng của đơn `PAID`") và I9 phải luôn đúng. Đơn rời `PAID` thì ghế và bộ đếm cũng phải rời theo.

Ghế về `AVAILABLE` không mở lại việc bán, vì đêm diễn đã `CANCELLED`.

### 6. Vé và soát vé

- Mỗi dòng của đơn được phát đúng một vé, trong transaction thanh toán (unique `order_item_id`). Mã vé là 128 bit ngẫu nhiên (`randomBytes(16)`, base64url). Mã này là thứ duy nhất cổng soát vé kiểm tra, nên phải **không đoán được**, chứ không chỉ cần duy nhất.
- Ảnh QR (SVG) được tạo khi đọc `GET /tickets`, bằng thư viện nhỏ `qrcode`; database chỉ lưu mã. Thư viện này được thêm vì đặc tả yêu cầu "vé kèm mã QR".
- Check-in là **một câu `UPDATE` có điều kiện** (I6), kèm `RETURNING` để trả luôn khu và ghế cho nhân viên soát vé. Nếu không khớp dòng nào, API đọc lại vé đúng một lần để trả lời rõ: không tồn tại (`404`), đã bị vô hiệu (`409 TICKET_VOIDED`), hoặc đã check-in lúc X bởi Y (`409 TICKET_ALREADY_CHECKED_IN`).

## Phương án đã loại

- **Trả `00` ngay rồi xử lý IPN trong queue.** Nếu bước xử lý sau đó thất bại, VNPay đã nhận `00` nên không gửi lại, và tiền có thể bị "treo". Xử lý đồng bộ, rồi để VNPay tự retry khi gặp `99`, thì an toàn hơn và đúng với đặc tả.
- **Tin Return URL.** Khách có thể đóng tab, và tham số trên URL có thể bị phát lại. Return URL chỉ dùng để hiển thị.
- **Khóa phân tán bằng Redis cho IPN.** Không cần: khóa dòng của PostgreSQL và câu `UPDATE` có điều kiện đã đủ, lại nằm cùng transaction với dữ liệu.
- **Lấy lại ghế cho tiền đến muộn.** Đặc tả cấm, vì ghế có thể đã thuộc về người khác. Đơn đã đóng thì luôn hoàn tiền (I8).
- **Một payment duy nhất cho mỗi đơn, dùng lại `txnRef`.** VNPay yêu cầu mỗi lần thanh toán một `txnRef` mới. Dùng lại sẽ gây lỗi trùng mã giao dịch phía cổng.
- **Lưu ảnh QR.** Ảnh suy ra được hoàn toàn từ mã vé, nên tạo khi cần là đủ.

## Hệ quả

- Có test tự động cho I2, I4, I6, I8, I12, gồm 20 bản sao IPN đến cùng lúc, hủy đơn đua với IPN, 20 lượt quét cùng một vé, và hoàn tiền thất bại tới DLQ. Hai test I4 và I6 đã được thử ngược: bỏ điều kiện bảo vệ thì test đỏ.
- Load test `webhook-chaos`, `full-flow` và `check-in` cho 0 vi phạm (xem [benchmark](../benchmarks.md)).
- **Load test làm lộ một lỗ hổng mô phỏng.** Ở 1.000 VU, pool 10 kết nối bị nghẽn. Một số IPN không mở được transaction nên trả `99`. Theo giao thức thì như vậy là đúng, vì VNPay sẽ gửi lại. Nhưng cổng giả lập lúc đầu không gửi lại, nên 15–36 đơn đã giữ vé không bao giờ được thanh toán. Sau khi cổng giả lập gửi lại giống VNPay, 500/500 đơn đã giữ đều được thanh toán và nhận vé.
- Cùng ở `full-flow`, khoảng 6% request giữ vé nhận `503` kèm `Retry-After`, vì giao dịch thanh toán và giao dịch giữ vé dùng chung pool. Đây là cơ chế bảo vệ khi quá tải đã có từ giai đoạn 2, không ảnh hưởng tính đúng. Sẽ đo lại ở giai đoạn 7a khi có nhiều instance.
- Trong `webhook-chaos`, ở biến thể "hủy đơn đua với IPN", lần đo này luôn là hủy đơn thắng. IPN phải xác minh chữ ký và đọc payment trước khi khóa đơn, nên đến sau. Test e2e chấp nhận cả hai kết quả và kiểm tra tổng: số đơn `PAID` cộng số refund đúng bằng số lượt.
- Dùng VNPay sandbox thật cần một URL công khai cho IPN (ví dụ qua tunnel) và phải khai báo URL IPN trong trang quản trị merchant sandbox. Hướng dẫn: [vnpay-sandbox.md](../vnpay-sandbox.md).
- Chưa có sự kiện `order.paid` trong outbox (I7). Phần này thuộc giai đoạn 8 (Kafka), và sẽ được ghi trong chính transaction ở mục 3.
