# ADR-0002: Prisma 7 với driver adapter `pg`

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 0

## Bối cảnh

Đặc tả chọn Prisma làm ORM, nhưng mọi câu lệnh khóa phải viết bằng raw SQL. Prisma 7 thay đổi nhiều so với các bản trước:

- Kết nối DB đi qua driver adapter (ở đây là `@prisma/adapter-pg`, dùng thư viện `pg`), không còn query engine viết bằng Rust.
- URL kết nối nằm trong `prisma.config.ts`, không nằm trong `schema.prisma`.
- Client được sinh ra thành mã TypeScript trong thư mục của dự án.

Tag `latest` trên npm của gói `prisma` đang trỏ tới `8.0.0-rc.19`, một bản release candidate.

## Quyết định

- Dùng **Prisma 7.10.0** (bản ổn định mới nhất), khóa đúng phiên bản cho cả `prisma`, `@prisma/client` và `@prisma/adapter-pg`.
- Client sinh vào `apps/api/src/generated/prisma` (không commit, được sinh lại khi `pnpm install`), với `moduleFormat = "esm"` và `importFileExtension = "js"`.
- Raw SQL dùng `$queryRaw` / `$executeRaw` dạng tagged template, để tham số luôn được bind và không bao giờ bị nối chuỗi.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Prisma 8 RC | Chưa ổn định; dự án đo hiệu năng nên không muốn lỗi của thư viện lẫn vào số liệu |
| TypeORM, Drizzle, Kysely | Chủ dự án đã chọn giữ Prisma. Prisma phổ biến trong tin tuyển dụng, và raw SQL vẫn viết được ở những chỗ cần |

## Hệ quả

- `importFileExtension = "js"` là bắt buộc. Nếu thiếu, code biên dịch vẫn import file `.ts`, và Node báo `ERR_MODULE_NOT_FOUND` khi chạy bản build. Lỗi này đã gặp thật ở giai đoạn 0.
- Driver adapter dùng connection pool của `pg`. Kích thước pool sẽ cần chỉnh khi load test (giai đoạn 2–3).
