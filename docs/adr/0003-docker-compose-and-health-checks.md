# ADR-0003: Docker Compose, migration chạy trước, và hai loại health check

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 0

## Bối cảnh

Định nghĩa hoàn thành yêu cầu `docker compose up` dựng được toàn bộ hệ thống từ máy sạch. Muốn vậy thì schema DB phải có sẵn trước khi API nhận request. Về sau (giai đoạn 7a) sẽ có nhiều instance API sau Nginx, nên cần biết instance nào sẵn sàng nhận tải.

## Quyết định

1. **Service `migrate` chạy một lần**: chạy `prisma migrate deploy` rồi thoát. API có `depends_on: service_completed_successfully`, nên chỉ khởi động sau khi migration thành công.
2. **Một Dockerfile nhiều stage**:
   - Stage `build` có đủ dependency dev, dùng cho migration và seed.
   - Stage `runtime` chỉ chứa dependency production và code đã biên dịch, chạy bằng user `node`.
3. **Hai endpoint health**:
   - `/health` (liveness) chỉ báo tiến trình còn sống, không kiểm tra DB.
   - `/health/ready` (readiness) kiểm tra PostgreSQL và Redis.
4. **Log**: container luôn ghi JSON. Log dễ đọc (`pino-pretty`) chỉ bật bằng `LOG_PRETTY=true` khi chạy trên máy.
5. **Cổng ra máy**: PostgreSQL map ra `5433` để không đụng PostgreSQL cài sẵn trên máy; cổng API đổi được bằng `API_PORT`.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Chạy migration trong lệnh khởi động API | Khi có 2 instance API, cả hai cùng chạy migration một lúc |
| Một endpoint health kiểm tra cả DB | Khi DB chập chờn, orchestrator thấy mọi instance "chết" và khởi động lại tất cả, làm sự cố nặng thêm |
| Bật `pino-pretty` theo `NODE_ENV=development` | Image production không có `pino-pretty`, nên API sập ngay lúc khởi động. Lỗi này đã gặp thật ở giai đoạn 0 |

## Hệ quả

- Lần `up` đầu tiên phải build image, mất vài phút.
- Redis bật AOF để khởi động lại không mất key đang giữ vé. Tính đúng vẫn do PostgreSQL quyết định.
