# ADR-0008: Chống bán trùng ngay tại database (ghế ngồi và vé đứng)

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-05
- Giai đoạn: 3

## Bối cảnh

Bản ngây thơ ở giai đoạn 2 bán trùng ở mọi lần đo: 4–11 ghế, và 925 vé đứng cho 500 chỗ (xem [benchmarks](../benchmarks.md)).

Nguyên nhân là kiểu "đọc, kiểm tra trong code, rồi ghi". Ở mức READ COMMITTED, câu `SELECT` thường không khóa gì, nên hai request có thể cùng đọc thấy ghế trống trước khi một trong hai kịp ghi.

Đặc tả yêu cầu so sánh 3 cách khóa ghế, và đo hiện tượng hot row ở khu đứng.

## Quyết định

### Ba lớp bảo vệ cho ghế ngồi (I1)

1. **Ứng dụng giữ ghế bằng `UPDATE` có điều kiện** (cách `conditional`, mặc định):

   ```sql
   UPDATE seats SET status = 'HELD'
   WHERE performance_id = $1 AND id = ANY($2) AND status = 'AVAILABLE'
   RETURNING id, zone_id
   ```

   Nếu số dòng trả về ít hơn số ghế khách yêu cầu, ném lỗi và rollback toàn bộ.

   Vì sao câu này đúng: khi có transaction khác đang ghi cùng dòng, PostgreSQL đợi transaction đó kết thúc, rồi **tính lại điều kiện `WHERE` trên phiên bản dòng mới nhất** (EvalPlanQual). Nên trong hai request cùng giữ một ghế, đúng một request khớp.

2. **Partial unique index** `order_items(seat_id) WHERE released_at IS NULL`. Nếu code ứng dụng có lỗi, database vẫn từ chối một ghế có hai đơn còn hiệu lực.

3. **Mọi transaction đặt vé đều chạy sau advisory lock theo (khách, đêm diễn)**. Xem [ADR-0009](0009-idempotency-and-ticket-limit.md).

### Vé đứng (I9)

1. **Một câu `UPDATE` có điều kiện**: kiểm tra sức chứa và tăng bộ đếm trong cùng một câu.

   ```sql
   UPDATE zones SET held_count = held_count + $n
   WHERE id = $1 AND held_count + sold_count + $n <= capacity
   ```

2. Câu này **chạy cuối cùng** trong transaction, ngay trước khi commit, để khóa trên dòng nóng được giữ ngắn nhất có thể.
3. **Check constraint** `zones_within_capacity` (`held_count + sold_count <= capacity`) là lớp bảo vệ cuối cùng.
4. **Chưa chia bộ đếm thành nhiều dòng** (lý do ở phần dưới).

### Ánh xạ lỗi

- **Vi phạm unique index hoặc check constraint**, nếu có lọt tới, được đổi thành lỗi nghiệp vụ `SEAT_UNAVAILABLE` hoặc `SOLD_OUT`.
- **Deadlock (`40P01`) và serialization failure (`40001`)** trả `503` kèm `Retry-After`. Transaction bị hủy không ghi gì cả, nên client thử lại là an toàn.

## So sánh 3 cách khóa ghế

Cả 3 cách đều được cài trong `SeatsService.hold()`. Chọn cách nào bằng `SEAT_HOLD_STRATEGY`, để có thể đo lại bất cứ lúc nào.

| Cách | Làm gì | Số lần gọi DB |
| --- | --- | --- |
| `conditional` | `UPDATE ... WHERE status = 'AVAILABLE'`, rồi kiểm tra số dòng | 1 |
| `pessimistic` | `SELECT ... ORDER BY id FOR UPDATE`, kiểm tra trong code, rồi `UPDATE` | 2 |
| `optimistic` | Đọc `xmin` (phiên bản dòng có sẵn của PostgreSQL), rồi `UPDATE ... WHERE xmin = <đã đọc>` | 2 |

**Kết quả đo** (5.000 lượt; cả 3 cách đều cho **0 ghế bán trùng** ở mọi lần chạy):

| Tải | conditional | pessimistic | optimistic |
| --- | --- | --- | --- |
| 1.000 VU (pool nghẽn) | 182–233 req/s | 170–228 req/s | 157–187 req/s |
| 50 VU, đã khởi động trước | 158–185 req/s, p95 349–471 ms | 150–172 req/s, p95 372–548 ms | 145–174 req/s, p95 387–468 ms |

**Kết luận:** chênh lệch giữa 3 cách **nhỏ hơn mức nhiễu của máy đo**, khoảng ±15% giữa các lần chạy trên cùng một laptop. Benchmark không chỉ ra được cách nào nhanh hơn. Vì vậy mình chọn `conditional` dựa trên thiết kế:
- **Ít lần gọi DB nhất** (1 so với 2), và không có bước "đọc trước" nào phải bảo vệ.
- **Dễ đọc nhất**: điều kiện kiểm tra nằm ngay trong câu ghi.
- **Không cần cột `version`**. Đặc tả dự kiến thêm cột này cho cách optimistic. Mình dùng `xmin` thay thế: đây là kỹ thuật thật (Npgsql và EF Core dùng nó), và không phải đổi schema chỉ để thử nghiệm.

## Hot row: có cần chia bộ đếm không?

Ở 50 VU, khu đứng đạt khoảng 130 req/s, so với khoảng 160–185 của ghế ngồi. Trước khi chia bộ đếm thành N dòng, mình đo xem hot row có thật sự là nút thắt:
- Lấy mẫu `pg_stat_activity` trong lúc chạy tải: chỉ khoảng **3,6%** số mẫu đang chờ khóa (`Lock:transactionid`). Phần lớn là `ClientRead`, nghĩa là PostgreSQL đang **chờ ứng dụng** gửi câu lệnh tiếp theo.
- `docker stats`: **API dùng khoảng 115% CPU** (luồng chính của Node chạy hết công suất), PostgreSQL khoảng 65%.

**Nút thắt hiện tại là tiến trình API, không phải khóa dòng.** Chia bộ đếm sẽ thêm một bảng, thêm cột shard vào `order_items`, và làm phức tạp luồng thanh toán và hết hạn ở giai đoạn 4–5, mà không cải thiện được gì lúc này. Sẽ đo lại khi chạy nhiều instance API (giai đoạn 7a), lúc CPU của ứng dụng không còn là giới hạn.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Mức cô lập `SERIALIZABLE` | Đúng, nhưng xung đột trả về `40001` và phải tự thử lại. Dưới tải tranh chấp cao, tỉ lệ phải thử lại rất lớn. Câu `UPDATE` có điều kiện đạt cùng mức an toàn ngay ở READ COMMITTED |
| Chỉ dựa vào unique index | Index chỉ có tác dụng khi `INSERT order_items`. Ghế vẫn có thể bị đổi sang `HELD` sai trước đó, và bộ đếm khu đứng không có index nào bảo vệ |
| Khóa ở tầng ứng dụng (mutex trong Node, Redis lock) | Không đúng khi có nhiều instance, hoặc khi Redis mất dữ liệu. Đặc tả quy định PostgreSQL là nguồn sự thật |
| Thêm cột `seats.version` | `xmin` làm được cùng việc mà không phải đổi schema; cách optimistic cũng không thắng trong benchmark |

## Hệ quả

- **Đã kiểm chứng:** 5 lần chạy `contention` liên tiếp, 5.000 khách mỗi lần, đều cho 0 ghế bán trùng (đúng 100 vé). `standing` phát đúng 500 vé, bộ đếm khớp. Có test tự động cho I1 (cả 3 cách khóa, nhiều ghế chồng nhau) và I9.
- **Với cách `conditional`, thứ tự khóa dòng phụ thuộc kế hoạch quét của PostgreSQL** (thường là theo index, tức theo `id`). Nếu có deadlock giữa hai đơn nhiều ghế, PostgreSQL tự phát hiện và API trả 503 để client thử lại. Cách `pessimistic` có `ORDER BY id`, nên đảm bảo tuyệt đối không deadlock.
- **Khi tải cao, khoảng một nửa số request vẫn nhận 503**, vì 1.000 request chờ 10 kết nối DB. Đây là bài toán công suất: Redis lọc trước khi vào DB (giai đoạn 4) và hàng chờ ảo (giai đoạn 7b) sẽ xử lý.
