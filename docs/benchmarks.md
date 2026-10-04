# Benchmark

Mỗi giai đoạn từ 2 trở đi thêm các dòng mới, không sửa dòng cũ. Cách đo và cấu hình máy: [đặc tả, mục 9](spec.md#9-yêu-cầu-phi-chức-năng-và-load-test).

## Cách đọc

- **Ghế bán trùng** là cột quan trọng nhất. Giá trị đúng duy nhất là 0.
  - `contention`: số ghế có từ 2 đơn còn hiệu lực trở lên (bất biến I1).
  - `standing`: số vé phát ra vượt sức chứa của khu (bất biến I9).
- **Lỗi** là tỉ lệ response 5xx. Từ giai đoạn 2, hệ thống quá tải trả **503** (`Retry-After`), không trả 500.
- **p50 / p95 / p99** là độ trễ của mọi request trong kịch bản, kể cả request bị từ chối.
- Mỗi lượt là một khách khác nhau, có token do seed tạo sẵn. Mọi lượt bắt đầu cùng lúc.

## Chạy lại

```bash
docker compose up -d --build
pnpm --filter @questa/api db:seed
pnpm loadtest contention          # hoặc standing, browse
pnpm loadtest contention --phase 3 --record "ghi chú"   # thêm một dòng vào bảng
```

## Kết quả

| Giai đoạn | Tag | Cấu hình | Kịch bản | Ghế bán trùng | RPS | p50 | p95 | p99 | Lỗi | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (1000 VU) | **4** ghế (+4 vé thừa) | 146 | 5797 ms | 12092 ms | 14098 ms | 56.10 % | Bản ngây thơ (đọc rồi ghi, không khóa). Pool 10, chờ 2 s. 3 lần chạy thử trước đó: 11 / 8 / 4 ghế bán trùng. 5xx là 503 do hết kết nối. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | standing: 5000 lượt (1000 VU) | **425** vé vượt sức chứa (925/500) | 120 | 7424 ms | 9133 ms | 11584 ms | 81.50 % | Bản ngây thơ (đọc bộ đếm, ghi giá trị tuyệt đối). Hot row: mọi request khóa cùng một dòng zones. Pool 20 + chờ 10 s còn tệ hơn. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | browse: 200 req/s × 30s | – | 157 | 2715 ms | 7813 ms | 7965 ms | 5.00 % | Đọc danh mục, chưa cache. Quá ngưỡng: một tiến trình Node đã hết CPU; 5 % lỗi là 503, 664 lượt bị k6 bỏ vì hết VU. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | browse: 100 req/s × 30s | – | 100 | 10 ms | 41 ms | 169 ms | 0.00 % | Đọc danh mục, chưa cache. Dưới ngưỡng: API dùng ~95% một nhân CPU. Ở 200 req/s (dòng trên) thì bão hòa. |
