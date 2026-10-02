# ADR-0001: pnpm workspace, NestJS 12 (ESM), Vitest và oxlint

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 0

## Bối cảnh

Dự án có hai ứng dụng: API (NestJS) và web (Next.js, từ giai đoạn 6). Đặc tả ban đầu đề xuất Jest và ESLint. Tại thời điểm khởi tạo, NestJS 12 tạo dự án mới mặc định là ESM, dùng Vitest để test và oxlint để lint. TypeScript mới nhất là 7.0 (bản viết lại bằng Go).

## Quyết định

1. **pnpm workspace** với `apps/api` và sau này `apps/web`, dùng chung một lockfile.
2. **Giữ mặc định của NestJS 12**: ESM, Vitest, oxlint (type-aware), Prettier.
3. **TypeScript 6.0**, không dùng 7.0.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Hai repo riêng cho API và web | Kiểu dữ liệu sinh từ Swagger phải đồng bộ giữa hai bên; một repo thì một PR đổi được cả hai, CI chạy chung |
| npm workspaces | pnpm nhanh hơn, tiết kiệm đĩa, chặn được việc dùng nhầm dependency không khai báo (phantom dependency) |
| Jest + ESLint như đặc tả ban đầu | Phải cấu hình ngược lại mặc định của framework. Jest hỗ trợ ESM kém; Vitest chạy ESM tự nhiên, API gần như giống Jest nên kiến thức vẫn dùng được |
| TypeScript 7.0 | `typescript-eslint` chỉ hỗ trợ TypeScript dưới 6.1 và NestJS CLI ghim `~6.0.2`; dùng 7.0 sẽ gặp xung đột peer dependency |

## Hệ quả

- Import nội bộ phải viết đuôi `.js` (quy tắc của ESM với `module: nodenext`).
- oxlint chưa có đủ luật như ESLint, nhưng các luật quan trọng nhất cho code bất đồng bộ (`no-floating-promises`, `no-misused-promises`) đều có và đã bật.
- Khi `typescript-eslint` và NestJS hỗ trợ TypeScript 7, có thể nâng cấp.
