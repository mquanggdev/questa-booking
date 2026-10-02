# ADR-0006: Quy ước API: validate, định dạng lỗi, Swagger, kiểm thử e2e

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 1

## Quyết định

1. **Validate input bằng class-validator** với `ValidationPipe`.
   - Bật `whitelist` và `forbidNonWhitelisted`: field lạ (ví dụ `role` trong body đăng ký) bị từ chối, không bị lờ đi.
   - Quy tắc liên quan nhiều field (đợt mở bán chồng nhau, tên khu trùng) kiểm tra ở service và trả về **mọi lỗi cùng lúc**.
2. **Một định dạng lỗi duy nhất**: `{ code, message, details? }`.
   - `code` là hằng số ổn định để client rẽ nhánh, ví dụ `EMAIL_TAKEN` hay `INVALID_STATE`.
   - Lỗi validate có `details: [{ field: "zones.1.name", errors: [...] }]`.
   - Lỗi không lường trước trả về `INTERNAL_ERROR`, không bao giờ lộ stack trace cho client.
3. **Swagger** tại `/api/docs`. DTO khai báo `@ApiProperty` tường minh.
4. **Một hàm `configureApp()` dùng chung** cho `main.ts` và e2e test, nên test chạy đúng pipeline của production: prefix, validate, filter lỗi, cookie.
5. **E2E test chạy trên database riêng `<db>_test` và Redis DB 1.** `globalSetup` tự tạo database và chạy migration; mỗi test xóa sạch bảng trước khi chạy.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| zod cho DTO (`nestjs-zod`) | class-validator là mặc định trong tài liệu NestJS và phổ biến hơn trong dự án NestJS. zod vẫn dùng để validate biến môi trường, nơi nó gọn hơn |
| Plugin CLI của `@nestjs/swagger` để tự sinh metadata | Plugin chỉ chạy khi `nest build`, không chạy trong Vitest, và chưa chắc tương thích với ESM. Khai báo tường minh dài hơn nhưng nhìn là thấy |
| E2E dùng chung database dev | Mỗi lần chạy test sẽ xóa dữ liệu seed đang dùng để thử tay |
| Mock Prisma trong e2e | Các lỗi quan trọng nhất của dự án (khóa, ràng buộc, transaction) chỉ lộ ra trên PostgreSQL thật |
