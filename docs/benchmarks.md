# Benchmark

Mỗi giai đoạn từ 2 trở đi thêm các dòng mới, không sửa dòng cũ. Cách đo và cấu hình máy: [đặc tả, mục 9](spec.md#9-yêu-cầu-phi-chức-năng-và-load-test).

## Cách đọc

- **Ghế bán trùng** là cột quan trọng nhất. Giá trị đúng duy nhất là 0.
  - `contention`: số ghế có từ 2 đơn còn hiệu lực trở lên (bất biến I1).
  - `standing`: số vé phát ra vượt sức chứa của khu (bất biến I9).
  - `quota`: số tài khoản giữ nhiều vé hơn giới hạn (bất biến I10).
- **Lỗi** là tỉ lệ response 5xx. Từ giai đoạn 2, hệ thống quá tải trả **503** (`Retry-After`), không trả 500.
- **p50 / p95 / p99** là độ trễ của mọi request trong kịch bản, kể cả request bị từ chối.
- Mỗi lượt là một khách khác nhau, có token do seed tạo sẵn. Mọi lượt bắt đầu cùng lúc.

## Chạy lại

```bash
docker compose up -d --build
pnpm --filter @questa/api db:seed
pnpm loadtest contention          # hoặc standing, quota, browse
pnpm loadtest contention --phase 3 --record "ghi chú"   # thêm một dòng vào bảng
```

## Kết quả

| Giai đoạn | Tag | Cấu hình | Kịch bản | Ghế bán trùng | RPS | p50 | p95 | p99 | Lỗi | Ghi chú |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (1000 VU) | **4** ghế (+4 vé thừa) | 146 | 5797 ms | 12092 ms | 14098 ms | 56.10 % | Bản ngây thơ (đọc rồi ghi, không khóa). Pool 10, chờ 2 s. 3 lần chạy thử trước đó: 11 / 8 / 4 ghế bán trùng. 5xx là 503 do hết kết nối. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | standing: 5000 lượt (1000 VU) | **425** vé vượt sức chứa (925/500) | 120 | 7424 ms | 9133 ms | 11584 ms | 81.50 % | Bản ngây thơ (đọc bộ đếm, ghi giá trị tuyệt đối). Hot row: mọi request khóa cùng một dòng zones. Pool 20 + chờ 10 s còn tệ hơn. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | browse: 200 req/s × 30s | – | 157 | 2715 ms | 7813 ms | 7965 ms | 5.00 % | Đọc danh mục, chưa cache. Quá ngưỡng: một tiến trình Node đã hết CPU; 5 % lỗi là 503, 664 lượt bị k6 bỏ vì hết VU. |
| 2 | `v0-naive` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | browse: 100 req/s × 30s | – | 100 | 10 ms | 41 ms | 169 ms | 0.00 % | Đọc danh mục, chưa cache. Dưới ngưỡng: API dùng ~95% một nhân CPU. Ở 200 req/s (dòng trên) thì bão hòa. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (1000 VU) | **0** ghế (+0 vé thừa) | 233 | 3981 ms | 5356 ms | 6847 ms | 49.96 % | Khóa ghế: conditional UPDATE (mặc định). 5 lần chạy trước đó liên tiếp: 0/0/0/0/0 ghế bán trùng, mỗi lần đúng 100 vé. 5xx là 503 do 1.000 request chờ 10 kết nối. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (1000 VU) | **0** ghế (+0 vé thừa) | 228 | 3957 ms | 6198 ms | 7311 ms | 51.58 % | Khóa ghế: pessimistic. So sánh với conditional ở cùng tải. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (1000 VU) | **0** ghế (+0 vé thừa) | 157 | 5544 ms | 9628 ms | 11828 ms | 14.18 % | Khóa ghế: optimistic. So sánh với conditional ở cùng tải. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (50 VU) | **0** ghế (+0 vé thừa) | 160 | 298 ms | 428 ms | 509 ms | 0.00 % | So sánh khóa ghế ở 50 VU (pool không nghẽn), đã khởi động trước: optimistic (xmin). |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (50 VU) | **0** ghế (+0 vé thừa) | 150 | 303 ms | 548 ms | 639 ms | 0.00 % | So sánh khóa ghế ở 50 VU (pool không nghẽn), đã khởi động trước: pessimistic. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | contention: 5000 lượt (50 VU) | **0** ghế (+0 vé thừa) | 158 | 291 ms | 471 ms | 639 ms | 0.00 % | So sánh khóa ghế ở 50 VU (pool không nghẽn), đã khởi động trước: conditional. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | standing: 5000 lượt (1000 VU) | **0** vé vượt sức chứa (500/500), lệch bộ đếm 0 | 177 | 4950 ms | 7731 ms | 8855 ms | 51.80 % | UPDATE có điều kiện, chạy cuối transaction. Đúng 500 vé, bộ đếm khớp. 5xx là 503 do chờ kết nối. |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | standing: 5000 lượt (50 VU) | **0** vé vượt sức chứa (500/500), lệch bộ đếm 0 | 134 | 356 ms | 517 ms | 643 ms | 0.00 % | 50 VU. Hot row không phải nút thắt: chỉ ~3,6% mẫu pg_stat_activity chờ khóa, API ~115% CPU. Chưa chia bộ đếm (ADR-0008). |
| 3 | `v1-db-lock` | R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB) | quota: 1000 lượt từ 20 tài khoản | **0** tài khoản vượt giới hạn (tối đa 6 vé/người) | 196 | 1817 ms | 3740 ms | 3993 ms | 0.00 % | Advisory lock theo (khách, đêm diễn). 20 tài khoản × 50 request song song: đúng 6 vé mỗi người, tổng 120. |
