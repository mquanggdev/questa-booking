# Questa Booking

[English](README.md) | **Tiếng Việt**

Backend bán vé concert, được xây để bán đúng số ghế đang có khi hàng nghìn người cùng mua một lúc, và chứng minh điều đó bằng số liệu.

> **Trạng thái:** Xong giai đoạn 3: chính PostgreSQL từ chối bán trùng (UPDATE có điều kiện, partial unique index, CHECK constraint, advisory lock, Idempotency-Key). 0 ghế bán trùng ở mọi lần chạy.

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

`docker compose up` khởi động PostgreSQL và Redis, chạy migration, rồi khởi động API.

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
```

| Lệnh | Việc |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Kiểm tra tĩnh |
| `pnpm test` | Unit test |
| `pnpm test:e2e` | E2E test trên database riêng `questa_test` (cần PostgreSQL và Redis) |

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
| 3 | so sánh 3 cách khóa ghế | đều đúng; chênh lệch nằm trong mức nhiễu giữa các lần chạy ([ADR-0008](docs/adr/0008-seat-and-standing-locking.md)) |

```bash
pnpm --filter @questa/api db:seed
pnpm loadtest contention      # hoặc: standing, quota, browse
```

## Tài liệu

- [Đặc tả](docs/spec.md)
- [Các quyết định kiến trúc (ADR)](docs/adr/)

## Giấy phép

[MIT](LICENSE)
