# ADR-0007: Cách load test, và trả 503 khi quá tải

- Trạng thái: Đã chấp nhận (thử nghiệm pool đã được đo lại ngày 2026-10-07, xem ADR-0011)
- Ngày: 2026-10-03
- Giai đoạn: 2

## Bối cảnh

Giai đoạn 2 cần một con số baseline đáng tin: bản ngây thơ bán trùng bao nhiêu ghế khi hàng nghìn người cùng mua. Có ba câu hỏi phải trả lời.

1. **Đo thế nào cho lặp lại được?** Lần đo sau phải so được với lần đo trước.
2. **Chạy k6 ở đâu?** Máy đo là Windows với Docker Desktop.
3. **Khi quá tải thì trả lời client thế nào?** Lần đo đầu tiên cho thấy 78% request nhận lỗi **500** "Unable to start a transaction in the given time": không phải bug logic, mà là pool kết nối DB bị dùng hết.

## Quyết định

1. **k6 chạy trong mạng của docker compose** (service `k6`, profile `loadtest`) và gọi thẳng `http://api:3000`. Nó không đi qua cổng chuyển tiếp của Docker Desktop trên Windows, vốn làm sai lệch độ trễ.
2. **Mỗi lượt là một khách khác nhau**, dùng token do seed tạo sẵn. Kịch bản dùng `per-vu-iterations`: 1.000 VU × 5 lượt = 5.000 khách, mọi VU bắt đầu cùng lúc.
3. **Mọi lần đo đều qua `pnpm loadtest <kịch bản>`** (`load-tests/run.mjs`). Script làm các bước theo thứ tự:
   - Reset đêm diễn thử về trạng thái chưa bán gì.
   - Chạy k6.
   - Kiểm tra bất biến bằng SQL (`load-tests/verify/invariants.sql`).
   - In báo cáo; nếu có `--record` thì thêm một dòng vào `docs/benchmarks.md`.
4. **Kiểm tra trực tiếp trong database**, không dựa vào response của API. Bán trùng là trạng thái trong DB: một ghế có từ 2 đơn còn hiệu lực trở lên.
5. **Quá tải trả 503 kèm `Retry-After`**, không trả 500:
   - Lỗi Prisma `P2028` (không lấy được kết nối trong `maxWait`) được map sang `503 SERVICE_UNAVAILABLE`.
   - Mỗi lỗi chỉ ghi một dòng `warn`, không in stack trace.
   - Kích thước pool và thời gian chờ chỉnh được qua `DB_POOL_MAX`, `DB_TX_MAX_WAIT_MS`, `DB_TX_TIMEOUT_MS`. Mặc định là 10 / 2 s / 10 s, giống mặc định của Prisma.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| 5.000 VU đồng thời như đặc tả ban đầu | Mỗi VU tốn bộ nhớ riêng. Docker trên máy đo chỉ có khoảng 7,7 GB. 1.000 VU × 5 lượt vẫn cho 5.000 khách khác nhau, và 1.000 request đến cùng một lúc là đủ để lộ lỗi |
| Chạy k6 trên Windows, gọi `localhost:3100` | Qua thêm một lớp chuyển cổng của Docker Desktop, độ trễ đo được không phải của API |
| Tăng pool và thời gian chờ cho đến khi hết lỗi | Đã thử pool 20, chờ 10 s, đo lại đúng cách ở giai đoạn 4 ([ADR-0011](0011-benchmark-config-integrity.md)). Hết lỗi 503, nhưng **thông lượng giảm một nửa** (209 → 104 req/s) và **p50 gấp đôi** (4,4 → 9,3 s). Lý do là hot row: mọi request giữ vé đứng cùng khóa **một dòng** `zones`, nên transaction xếp hàng lần lượt, và pool to hơn chỉ làm hàng đợi dài hơn. Cách chữa thật là rút ngắn transaction (giai đoạn 3), lọc bớt trước DB (giai đoạn 4) và giới hạn lượng người vào (hàng chờ ảo, giai đoạn 7b) |
| Để lỗi 500 như cũ | 500 nghĩa là "server hỏng", client không nên thử lại. Thực tế server chỉ đang bận, nên 503 kèm `Retry-After` mới đúng |

## Hệ quả

- **Bản ngây thơ bán trùng ở mọi lần đo**: 4–11 ghế với `contention`. Với `standing`, 925 vé được phát cho khu 500 chỗ, nhưng bộ đếm chỉ ghi 94, tức mất 831 lần cập nhật.
- **Một tiến trình Node đọc được khoảng 100 req/s** (p95 41 ms) thì đã dùng gần hết một nhân CPU. Ở 200 req/s thì bão hòa. Đây là baseline cho cache và nhiều instance ở giai đoạn 7a.
- **Số liệu dao động giữa các lần chạy** vì k6, API và PostgreSQL chạy chung một laptop. Mỗi dòng benchmark ghi rõ điều kiện đo.
