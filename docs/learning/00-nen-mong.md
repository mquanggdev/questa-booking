# Giai đoạn 0: Nền móng

## Đã làm

- pnpm workspace với `apps/api` (NestJS 12, TypeScript strict, ESM).
- Cấu hình đọc từ biến môi trường, validate bằng zod. Thiếu hoặc sai biến thì app không khởi động và báo rõ biến nào.
- Prisma 7 nối PostgreSQL qua driver adapter; ioredis nối Redis.
- Log có cấu trúc bằng Pino (JSON), tự che header `Authorization` và `Cookie`.
- `/api/v1/health` (liveness) và `/api/v1/health/ready` (readiness).
- Docker Compose: PostgreSQL 18, Redis 8, service `migrate`, API.
- GitHub Actions: format, lint, typecheck, unit test, e2e test (PostgreSQL và Redis chạy dạng service), build image.
- `CLAUDE.md` và các skill cho agent.

## Vì sao

### Validate biến môi trường ngay khi khởi động (fail fast)

Nếu `DATABASE_URL` sai mà app vẫn chạy, lỗi chỉ lộ ra ở request đầu tiên chạm DB, có khi vài giờ sau khi deploy. Validate lúc khởi động biến lỗi cấu hình thành lỗi deploy, tức là lỗi thấy ngay.

### Liveness khác readiness

- **Liveness** trả lời câu "tiến trình có bị treo không?". Nếu không, thì khởi động lại.
- **Readiness** trả lời câu "có nên gửi request vào đây không?". Nếu không, thì tạm ngừng gửi tải.

Nếu liveness kiểm tra cả DB, thì lúc DB chậm, mọi instance API đều bị khởi động lại cùng lúc. Sự cố nhỏ thành sự cố lớn.

### Log JSON thay vì `console.log`

Khi có 2 instance API và 1 worker, phải lọc và tìm log theo trường (`level`, `reqId`, `orderId`). Log dạng text không lọc theo trường được.

### Multi-stage Dockerfile

Image production không chứa TypeScript, Vitest hay Prisma CLI. Image nhỏ hơn, ít lỗ hổng hơn, và chạy bằng user không phải root.

## Lỗi đã gặp

| Lỗi | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND .../class.ts` khi chạy bản build | Client Prisma 7 sinh ra import file `.ts`; `tsc` giữ nguyên đường dẫn import | `importFileExtension = "js"` trong generator |
| API sập trong container: `unable to determine transport target for "pino-pretty"` | `pino-pretty` là dev dependency, không có trong image production | Tách thành cờ `LOG_PRETTY` |
| E2E test báo DB `down`, dù container vẫn khỏe | Máy có PostgreSQL cài sẵn chiếm cổng 5432; test kết nối nhầm vào DB đó | Map PostgreSQL của Docker ra cổng 5433 |
| Cổng 3000 đã bị chiếm | Container của dự án khác | Cổng API đổi được bằng `API_PORT` |
| Container báo `unhealthy`, dù gọi `/health/ready` từ máy vẫn trả ok | Trong container, `localhost` trỏ sang `::1` (IPv6), còn app chỉ lắng nghe `0.0.0.0` (IPv4) | Health check gọi `127.0.0.1` |

## Câu hỏi phỏng vấn có thể gặp

1. Liveness probe khác readiness probe thế nào? Vì sao liveness không nên kiểm tra DB?
2. Vì sao phải validate cấu hình lúc khởi động?
3. Multi-stage build trong Docker giải quyết vấn đề gì?
4. Chạy migration ở đâu khi có nhiều instance API? Vì sao không để mỗi instance tự chạy migration?
5. ESM khác CommonJS ra sao? Vì sao import trong TypeScript lại phải ghi đuôi `.js`?
6. Vì sao log nên ở dạng JSON? Cần che những trường nào?
