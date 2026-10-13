# ADR-0017: Outbox trong transaction, relay sang Kafka, ba consumer idempotent

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-13
- Giai đoạn: 8

## Bối cảnh

Giai đoạn 8 yêu cầu (đặc tả, mục 10):

- Kafka một node chế độ KRaft;
- bảng `outbox_events`, ghi sự kiện trong transaction của luồng B, luồng C và luồng hủy đêm diễn;
- relay trong worker;
- ba consumer `notifications`, `analytics`, `audit`, idempotent qua `processed_events`, có topic dead letter;
- email vé qua Mailpit;
- trang theo dõi mở bán nhận `sales.updated`.

Định nghĩa hoàn thành: test chứng minh I7 trong ba tình huống: relay bị tắt giữa chừng, Kafka tạm ngừng rồi chạy lại, một sự kiện bị gửi hai lần.

**I7**: mỗi đơn `PAID` có đúng một sự kiện `order.paid`, và mỗi consumer áp dụng nó đúng một lần.

Vấn đề gốc là ghi kép (dual write): nếu code vừa commit vào PostgreSQL vừa gửi lên Kafka, thì một trong hai có thể thất bại sau khi cái kia đã thành công. Kết quả là đơn đã `PAID` mà không có sự kiện, hoặc có sự kiện cho một đơn bị rollback.

## Quyết định

### 1. Sự kiện được ghi vào outbox, trong cùng transaction với thay đổi

| Sự kiện | Ghi ở đâu (cùng transaction với) |
| --- | --- |
| `order.paid` | `PENDING → PAID` trong IPN (luồng B, bước 5) |
| `order.expired` | `PENDING → EXPIRED` (luồng C, job hết hạn hoặc job quét) |
| `order.cancelled`, `reason: CUSTOMER` | khách hủy đơn `PENDING` |
| `order.cancelled`, `reason: PERFORMANCE_CANCELLED`, `wasPaid: false` | hủy đêm diễn đóng một đơn `PENDING` |
| `order.cancelled`, `reason: PERFORMANCE_CANCELLED`, `wasPaid: true` | hủy đêm diễn với đơn đã `PAID`: vé bị vô hiệu, ghế và bộ đếm được trả lại |
| `order.refunded` | `REFUND_PENDING → REFUNDED`, khi cổng thanh toán xác nhận đã hoàn tiền |

- Mỗi bước chuyển trạng thái đã là câu `UPDATE ... WHERE status = <cũ>` (đúng một lần), nên mỗi sự kiện cũng được ghi đúng một lần. Ví dụ, IPN gửi hai lần thì lần thứ hai không khớp `PENDING` và không ghi gì.
- Đơn đã trả tiền bị hủy vì đêm diễn bị hủy phát `order.cancelled` **ngay lúc vé bị vô hiệu**, chứ không chờ tới lúc hoàn tiền. Nhờ vậy thống kê trừ đi đúng lúc, kể cả khi lần hoàn tiền vào DLQ và không bao giờ xong. `order.refunded` chỉ báo rằng tiền đã về tay khách.
- `outbox_events.id` (uuidv7) chính là `eventId`. Cột `payload` chỉ chứa `data`; relay bọc thành phong bì `{ eventId, eventType, occurredAt, version, data }` của đặc tả khi gửi đi.
- Dữ liệu sự kiện lấy ngay từ `UPDATE ... RETURNING` (người mua, đêm diễn, tổng tiền, giá từng vé), không tốn thêm truy vấn.

### 2. Relay: khóa lô bằng `FOR UPDATE SKIP LOCKED`, gửi, chờ xác nhận, rồi đánh dấu

Mỗi `OUTBOX_RELAY_EVERY_MS` (500 ms), worker chạy một transaction:

1. lấy tối đa 100 dòng `published_at IS NULL` theo `created_at`, kèm `FOR UPDATE SKIP LOCKED`;
2. gửi lên `orders.events` với key là `orderId`, rồi chờ broker xác nhận (`acks=all`, producer idempotent);
3. `UPDATE published_at`, rồi commit.

- `SKIP LOCKED`: nếu có worker thứ hai, nó lấy lô kế tiếp thay vì chờ, và hai worker không bao giờ gửi cùng một dòng cùng lúc.
- Relay chết sau khi Kafka đã xác nhận nhưng trước khi commit: các dòng vẫn chưa được đánh dấu và sẽ được gửi lại, nên Kafka có thể nhận trùng. Đây là "ít nhất một lần", và consumer phải tự chống trùng.
- Kafka ngừng: lệnh gửi thất bại sau `KAFKA_SEND_TIMEOUT_MS`, transaction rollback, các dòng vẫn chờ. Transaction kéo dài lâu hơn thời gian chờ gửi.
- Partial index trên `created_at WHERE published_at IS NULL`: relay chỉ quét các dòng chưa gửi, chứ không quét cả bảng.
- Key là `orderId`: mọi sự kiện của một đơn nằm trên cùng một partition, nên đến consumer theo đúng thứ tự gửi.

### 3. Consumer: `processed_events` cùng transaction với tác dụng; thử lại; DLQ

- Mỗi consumer là một consumer group, đọc `orders.events` với 3 partition xử lý song song.
- Với mỗi sự kiện, trong một transaction:

  ```sql
  INSERT INTO processed_events (consumer, event_id) VALUES (...) ON CONFLICT DO NOTHING
  ```

  Chèn được 0 dòng nghĩa là đã áp dụng rồi, nên bỏ qua. Chèn được 1 dòng thì áp dụng tác dụng trong cùng transaction. Hai việc cùng commit hoặc cùng không xảy ra.
- Đọc mã nguồn thư viện cho thấy: khi hàm xử lý ném lỗi, client lùi về đúng offset đó và **giao lại ngay**, không có backoff. Vì vậy consumer tự thử lại `CONSUMER_MAX_ATTEMPTS` lần (backoff 200, 400, 800 ms…). Hết lượt thì gửi message sang `orders.events.dlq`, kèm header `consumer`, `error`, `attempts`, để một sự kiện hỏng không chặn cả partition mãi mãi. Nếu chính việc gửi DLQ cũng thất bại thì ném lỗi, để Kafka giao lại message.
- **analytics**: `order.paid` cộng số vé và doanh thu theo khu vào `performance_sales_stats`; `order.cancelled` có `wasPaid` thì trừ đi. Sau khi commit, nó phát `sales.updated` cho phòng của đêm diễn trên namespace `/sales` (chỉ chủ concert được vào).
  - Phép trừ dùng `UPDATE`, không dùng upsert: PostgreSQL kiểm tra ràng buộc `CHECK (>= 0)` trên dòng được đề xuất chèn **trước khi** phát hiện trùng khóa, nên một upsert với số âm bị từ chối dù kết quả cuối cùng hợp lệ. Lỗi này lộ ra nhờ test e2e.
  - Trừ vào một khu chưa từng có lượt bán thì báo lỗi, để sự kiện đó vào DLQ.
- **audit**: mỗi sự kiện một dòng `audit_logs`, có `event_id` unique.
- **notifications**: email cho người mua (vé kèm mã QR nhúng `cid:`, đêm diễn bị hủy, đã hoàn tiền), qua nodemailer tới Mailpit ở local. Hết hạn giữ vé và khách tự hủy thì không gửi, vì khách đã biết.

### 4. Email: "ít nhất một lần", và đó là giới hạn có chủ ý

Email không thể nằm trong transaction. Email được gửi **trước khi** transaction ghi `processed_events` commit:

- gửi lỗi thì không có gì được ghi, và sự kiện được thử lại;
- tiến trình chết sau khi gửi nhưng trước khi commit thì email được gửi lại.

Kết quả là email không bao giờ mất, hiếm khi đến hai lần, và hai bản có cùng `Message-ID` (`<eventId@questa.test>`) để hộp thư nhận ra. Làm ngược lại (commit trước, gửi sau) thì có thể mất email, mà mất vé tệ hơn nhận trùng một email. I7 về "áp dụng đúng một lần" vẫn đúng cho phần dữ liệu của consumer (`processed_events`).

### 5. Thống kê mở bán: nhất quán sau (eventually consistent)

- `GET /performances/:id/stats` (chỉ chủ concert): số vé đã bán và doanh thu lấy từ `performance_sales_stats`, nên trễ một chút so với lúc thanh toán, vì sự kiện phải qua outbox, Kafka và consumer (test trình duyệt chờ tối đa 8 s và đạt). Số vé đang giữ và độ dài hàng chờ đọc trực tiếp.
- Trang `/performances/:id/sales` nhận `sales.updated`, và hỏi lại mỗi 10 s để cập nhật vé đang giữ.

### 6. Thư viện, phiên bản và hạ tầng

- `@confluentinc/kafka-javascript` 1.10.1 (đặc tả chọn), là binding librdkafka. Có bản build sẵn cho Windows và cho Alpine/musl, đã kiểm cả hai.
- pnpm chỉ cho phép script cài đặt của gói này, vốn chỉ tải bản build sẵn từ GitHub Releases của Confluent.
- Bản 1.11.0 mới ra 6 ngày nên không dùng. nodemailer 10.0.12 có sẵn kiểu TypeScript.
- Kafka `apache/kafka:4.1.2`, KRaft, một node. Container dùng `kafka:9092`, máy host dùng `localhost:9094`. Tắt tự tạo topic: worker tự tạo `orders.events` (3 partition) và `orders.events.dlq`.
- Mailpit `axllent/mailpit:v1.27.10`, hộp thư ở `:8025`.
- Test e2e dùng prefix topic và consumer group riêng cho mỗi lần chạy. CI có service Kafka và Mailpit.

## Phương án đã loại

- **Gửi thẳng lên Kafka sau khi commit.** Đây chính là ghi kép: tiến trình chết giữa hai bước thì mất sự kiện.
- **Producer có transaction của Kafka (exactly-once) thay cho outbox.** Transaction của Kafka không bao gồm transaction của PostgreSQL, nên vẫn là ghi kép.
- **Change Data Capture (Debezium) đọc WAL.** Hạ tầng lớn hơn hẳn (Kafka Connect), vượt phạm vi đặc tả, và khó giải thích hơn một relay vài chục dòng.
- **Consumer chống trùng bằng Redis.** Kiểm tra trùng phải nằm cùng transaction với tác dụng; Redis không cho được điều đó.
- **Commit offset thủ công sau mỗi message.** Không cần: thư viện chỉ lưu offset sau khi xử lý thành công, và `processed_events` đã lo phần giao trùng.
- **Gửi email sau khi commit.** Có thể mất email (mục 4).

## Hệ quả

- **I7 có test e2e** (`events.e2e-spec.ts`):
  - relay "chết" giữa lúc gửi và lúc đánh dấu: Kafka nhận 2 bản, mỗi consumer áp dụng 1 lần;
  - `docker pause` Kafka: sự kiện nằm chờ trong outbox, chạy lại thì được gửi và áp dụng 1 lần;
  - cùng một sự kiện gửi thêm 2 lần: vẫn áp dụng 1 lần.

  Thử ngược: bỏ chống trùng thì 3 test hỏng; relay không chờ Kafka xác nhận thì sự kiện bị đánh dấu "đã gửi" khi Kafka đang ngừng, test hỏng.
- **Load test `full-flow`** kiểm thêm I7 sau khi sự kiện xử lý xong: 500 `order.paid`, 0 vi phạm, audit và thống kê khớp. Kể cả khi **giết worker giữa lúc tải**, cũng 0 vi phạm.
- Worker cần Kafka và Mailpit khi khởi động; API thì không, vì API chỉ ghi vào outbox.
- RAM: Kafka giới hạn 768 MB (heap 384 MB). Cần tính vào ngân sách 3,5 GB của VPS ở giai đoạn 9.
- `occurredAt` là `created_at`, tức thời điểm **transaction bắt đầu**. Thứ tự các sự kiện của cùng một đơn vẫn đúng, vì các bước chuyển trạng thái của một đơn khóa cùng một dòng.
- Số liệu: [benchmark](../benchmarks.md), các dòng giai đoạn 8.
