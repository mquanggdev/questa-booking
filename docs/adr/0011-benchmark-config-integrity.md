# ADR-0011: Mỗi lần đo phải ghi lại cấu hình thật của API

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-07
- Giai đoạn: 4

## Bối cảnh: một lỗi đo đã làm sai ba thí nghiệm

Để so sánh hai cấu hình, mình khởi động API với biến môi trường ghi đè, ví dụ:

```bash
SEAT_HOLD_STRATEGY=pessimistic docker compose up -d api
```

Sau đó mới chạy `pnpm loadtest`. Script này gọi `docker compose run k6`. Service `k6` có `depends_on: api`, nên compose **dựng lại cấu hình của `api` từ file `.env`**, lúc này không còn biến ghi đè. Thấy cấu hình khác container đang chạy, compose **tạo lại container API với cấu hình mặc định**, ngay trước khi k6 bắt đầu.

Mình kiểm tra cấu hình bằng `printenv` **trước** lệnh `pnpm loadtest`, nên không phát hiện ra. Lỗi chỉ lộ ra ở giai đoạn 4: bật hay tắt bộ lọc Redis đều cho cùng một con số. Kiểm tra trực tiếp thì thấy:

```text
before: gate=false strat=pessimistic
 Container questa-api-1 Recreate
after:  gate=true  strat=conditional
```

## Những kết luận bị ảnh hưởng

| Thí nghiệm | Ghi trước đây | Sau khi đo lại đúng |
| --- | --- | --- |
| Giai đoạn 2: pool 20 + chờ 10 s trên bản ngây thơ | "còn tệ hơn" | **Đúng một phần.** Thông lượng giảm một nửa (209 → 104 req/s), p50 gấp đôi (4,4 → 9,3 s), đúng hiện tượng hot row. Nhưng hết lỗi 503, và gần như mọi request đều được bán: 5.000 vé cho 500 chỗ |
| Giai đoạn 3: so sánh 3 cách khóa ghế | "chênh lệch trong mức nhiễu" | Cả 3 lần cũ đều chạy `conditional`. Đo lại thật thì 3 cách **vẫn ngang nhau**: 165–183 req/s, p95 317–431 ms ở 50 VU. Kết luận không đổi, nhưng giờ mới có bằng chứng |
| Giai đoạn 4: bật và tắt bộ lọc Redis | (chưa ghi) | Cả hai lần đều đang bật. Đo đúng thì bộ lọc **tăng thông lượng khoảng 4 lần** |

Các kết quả **về tính đúng** (0 ghế bán trùng, I9, I10) không bị ảnh hưởng: chúng đo trên cấu hình mặc định, cũng là cấu hình được dùng thật.

## Quyết định

1. `run.mjs` chạy k6 bằng `docker compose run --no-deps`, nên không bao giờ đụng tới service `api`.
2. Ngay trước và ngay sau khi chạy k6, script **đọc cấu hình thật từ chính container đang chạy** (`printenv` các biến quan trọng) và **id của container**. Nếu một trong hai thay đổi trong lúc đo, kết quả bị hủy và script báo lỗi.
3. Cấu hình thật đó được **in ra trong báo cáo và ghi vào cột "Cấu hình"** của mỗi dòng benchmark. Một dòng không có cấu hình đi kèm thì không dùng để so sánh được.
4. Dòng benchmark sai **không bị xóa**. Nó được đánh dấu ⚠ và trỏ tới dòng đo lại, để lịch sử vẫn trung thực.

## Bài học

- **Kiểm tra trạng thái đúng lúc đo, không phải trước khi đo.** Mình đã `printenv` rồi mới chạy load test, nhưng trạng thái lại thay đổi ở giữa hai bước đó.
- **Kết quả "quá đẹp" hoặc "không đổi gì" đều phải nghi ngờ.** Hai cấu hình khác nhau mà cho cùng một con số là dấu hiệu thí nghiệm có vấn đề, không phải dấu hiệu chúng ngang nhau.
- **Cần thí nghiệm đối chứng.** Chạy lại code giai đoạn 3 (tag `v1-db-lock`) ngay trên máy hôm đó đã giúp tách được "máy nhanh lên" ra khỏi "code thay đổi".
