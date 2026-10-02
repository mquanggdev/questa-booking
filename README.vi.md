# Questa Booking

[English](README.md) | **Tiếng Việt**

Backend bán vé concert, được xây để bán đúng số ghế đang có khi hàng nghìn người cùng mua một lúc, và chứng minh điều đó bằng số liệu.

> **Trạng thái:** Giai đoạn 0 (nền móng) của lộ trình. Các tính năng đặt vé bắt đầu từ giai đoạn 1. Xem [lộ trình](docs/spec.md#10-lộ-trình-triển-khai).

## Bài toán

Đợt mở bán vé là những đợt truy cập ngắn và dồn dập, khi rất nhiều người cùng muốn vài ghế giống nhau. Cách làm ngây thơ "đọc ghế, thấy trống, rồi ghi" sẽ bán một ghế cho hai người khi tải cao.

Dự án bắt đầu từ đúng phiên bản lỗi đó, đo số ghế bị bán trùng, rồi loại bỏ lỗi từng bước: khóa ở database, giữ vé có thời hạn bằng Redis, thanh toán idempotent, chạy nhiều instance, hàng chờ ảo, và phát sự kiện qua Kafka. Mỗi bước đều có benchmark.

## Công nghệ

NestJS 12 (TypeScript, ESM) · PostgreSQL 18 · Prisma 7 · Redis 8 · BullMQ · Kafka · Socket.IO · Next.js · k6 · Docker Compose · GitHub Actions · Prometheus và Grafana

Lý do có mặt của từng công nghệ: [`docs/decisions/`](docs/decisions/).

## Chạy thử

Cần có: Docker, Node.js 24, pnpm.

```bash
cp .env.example .env
docker compose up -d --build
curl localhost:3000/api/v1/health/ready
```

`docker compose up` khởi động PostgreSQL và Redis, chạy migration, rồi khởi động API.

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
| `pnpm test:e2e` | E2E test (cần PostgreSQL và Redis) |

## Benchmark

Bắt đầu từ giai đoạn 2, với phiên bản ngây thơ còn bán trùng. Xem [`docs/benchmarks.md`](docs/benchmarks.md).

## Tài liệu

- [Đặc tả](docs/spec.md)
- [Các quyết định kiến trúc (ADR)](docs/decisions/)
- [Ghi chú học tập theo giai đoạn](docs/learning/)
