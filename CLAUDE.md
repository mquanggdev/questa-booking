# Questa Booking: quy tắc cho agent

Backend bán vé concert chịu tải cao, làm portfolio cho vị trí Backend Developer (fresher). Chủ dự án vừa muốn có dự án hoàn chỉnh, vừa muốn học công nghệ. Vì vậy mọi quyết định phải giải thích được.

Nguồn quyết định: [`docs/spec.md`](docs/spec.md). Khi đặc tả thiếu hoặc mâu thuẫn, agent tự quyết theo kinh nghiệm, ghi ADR và báo lại. Agent chỉ hỏi khi việc đó thêm phạm vi hoặc công nghệ lớn ngoài đặc tả, tốn tiền, dùng tài khoản bên ngoài, hoặc ra ngoài máy (tạo repo, push, deploy).

## Quy trình

1. Làm tuần tự theo giai đoạn ở mục 10 của đặc tả, không nhảy cóc. Giai đoạn hiện tại: **0**.
2. Đầu mỗi giai đoạn: chia việc bằng skill `planning-and-task-breakdown`.
3. Cuối mỗi giai đoạn: chạy skill `/phase-check`, rồi **dừng lại báo cáo** cho chủ dự án. Chủ dự án review xong mới gắn tag git.
4. Giai đoạn 2 cố ý chứa lỗi bán trùng. Không sửa sớm. Gắn tag `v0-naive` trước khi sang giai đoạn 3.
5. Không thêm công nghệ, thư viện lớn hoặc tính năng ngoài đặc tả khi chưa được đồng ý.

## Quy tắc code

- Code, tên biến, comment, commit message, mô tả Swagger: **tiếng Anh**.
- Mọi câu lệnh khóa ở database (`FOR UPDATE`, advisory lock, `UPDATE` có điều kiện) viết bằng **raw SQL có comment**, không giấu sau ORM.
- Không đổi schema bằng tay. Mọi thay đổi đi qua migration Prisma. Partial index và ràng buộc check viết bằng SQL trong migration.
- Mỗi bất biến (I1–I12) phải có ít nhất một test tự động chứng minh.
- Bước chuyển trạng thái đơn: `UPDATE ... WHERE status = <cũ>` rồi kiểm tra số dòng bị ảnh hưởng.
- Không commit secret. Mọi cấu hình đọc từ biến môi trường, validate bằng zod trong `apps/api/src/config/env.schema.ts`, và có trong `.env.example`.
- Module chỉ gọi service công khai của module khác, không truy vấn bảng của module khác.
- TypeScript strict, ESM: import nội bộ phải có đuôi `.js`.
- Commit nhỏ, theo Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`).

## Tài liệu

- `docs/` (đặc tả, ADR, benchmark, ghi chú học tập): **tiếng Việt**.
- README: `README.md` (tiếng Anh) và `README.vi.md` (tiếng Việt), cập nhật cả hai trong cùng một commit.
- Quyết định kỹ thuật đáng kể: một ADR trong `docs/decisions/NNNN-ten-ngan.md` (bối cảnh, quyết định, phương án đã loại, hệ quả). Dùng skill `documentation-and-adrs`.
- Cuối mỗi giai đoạn: `docs/learning/NN-ten-giai-doan.md` gồm đã làm gì, vì sao, và câu hỏi phỏng vấn có thể gặp.

## Lệnh

Chạy từ thư mục gốc repo:

| Lệnh | Việc |
| --- | --- |
| `docker compose up -d --build` | Dựng PostgreSQL, Redis, chạy migration, API |
| `pnpm install` | Cài dependency (tự chạy `prisma generate`) |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | Kiểm tra code |
| `pnpm test` | Unit test (không cần DB) |
| `pnpm test:e2e` | E2E test (cần PostgreSQL và Redis đang chạy) |
| `pnpm --filter @questa/api prisma:migrate` | Tạo và áp dụng migration mới |

Cổng trên máy chủ dự án: PostgreSQL `5433` (máy có sẵn PostgreSQL ở 5432), Redis `6379`, API `API_PORT` trong `.env` (máy chủ dự án dùng `3100`, vì 3000 đã bị dự án khác chiếm).

## Skill

Đặt trong `.claude/skills/`. Nguồn gốc ghi ở `.claude/skills/README.md`.

| Skill | Dùng khi |
| --- | --- |
| `planning-and-task-breakdown` | Đầu mỗi giai đoạn |
| `test-driven-development` | Viết logic nghiệp vụ, đặc biệt là các bất biến |
| `doubt-driven-development` | Quyết định rủi ro cao: khóa ghế, IPN, outbox, state machine. Không có Gemini hay Codex CLI: bỏ qua bước review chéo khác model, chỉ cần báo một dòng, không hỏi |
| `source-driven-development` | Dùng API của thư viện mới hơn kiến thức có sẵn: NestJS 12, Prisma 7, BullMQ, Kafka client |
| `prisma-cli`, `prisma-client-api` | Mọi việc với Prisma 7 |
| `api-and-interface-design` | Thiết kế endpoint, DTO, interface payment provider |
| `security-and-hardening` | Auth, token, IPN, rate limit |
| `debugging-and-error-recovery` | Test hỏng, load test lỗi, deadlock |
| `documentation-and-adrs` | Viết ADR |
| `phase-check` | Cuối mỗi giai đoạn |

Review code dùng lệnh có sẵn `/code-review` và `/security-review` của Claude Code.
