# AGENTS.md: Questa Booking

Backend bán vé concert chịu tải cao, làm portfolio cho vị trí Backend Developer (fresher). Chủ dự án vừa muốn có dự án hoàn chỉnh, vừa muốn học công nghệ. Vì vậy mọi quyết định phải giải thích được.

Nguồn quyết định: [`docs/spec.md`](docs/spec.md). Khi đặc tả thiếu hoặc mâu thuẫn, agent tự quyết theo kinh nghiệm, ghi ADR và báo lại. Agent chỉ hỏi khi việc đó thêm phạm vi hoặc công nghệ lớn ngoài đặc tả, tốn tiền, dùng tài khoản bên ngoài, hoặc ra ngoài máy (tạo repo, push, deploy).

## Nguyên tắc

1. **Đừng sợ tốn công.** Làm đúng và làm đủ, không đi đường tắt:
   - Đọc tài liệu chính thức thay vì đoán API.
   - Chạy lại và kiểm chứng thay vì giả định là đã chạy được.
   - Viết test cho trường hợp khó, không chỉ trường hợp dễ.
   - Thấy cách làm hiện tại sai hoặc chưa tốt thì sửa lại, kể cả khi phải làm lại nhiều.
   - Giải thích kỹ khi báo cáo.
2. **Đúng trước, nhanh sau.** Tính đúng (không bán trùng, không mất tiền) là tuyệt đối; hiệu năng là thứ đo và cải thiện dần.
3. **Theo chuẩn phổ biến.** Cấu trúc thư mục, cách đặt tên và cách tổ chức code đi theo quy ước phổ biến của NestJS, Next.js và Prisma. Không tự chế cấu trúc lạ.
4. **Không thêm thứ không cần.** Không thêm công nghệ, thư viện lớn hoặc tính năng ngoài đặc tả khi chưa được đồng ý.

## Quy trình

1. Làm tuần tự theo giai đoạn ở mục 10 của đặc tả, không nhảy cóc. Giai đoạn hiện tại: **0**.
2. Cuối mỗi giai đoạn: kiểm tra "Định nghĩa hoàn thành" ở mục 10 của đặc tả, rồi **dừng lại báo cáo** cho chủ dự án. Chủ dự án review xong mới gắn tag git.
3. Giai đoạn 2 cố ý chứa lỗi bán trùng. Không sửa sớm. Gắn tag `v0-naive` trước khi sang giai đoạn 3.

## Cấu trúc thư mục

```text
apps/
  api/                    # NestJS
    src/
      main.ts             # khởi động API
      worker.ts           # khởi động worker (từ giai đoạn 4)
      app.module.ts
      config/             # biến môi trường, validate bằng zod
      common/             # decorator, filter, guard, interceptor, pipe dùng chung
      prisma/             # PrismaModule, PrismaService
      redis/              # RedisModule
      modules/            # mỗi tính năng một thư mục: *.module.ts, *.controller.ts,
                          # *.service.ts, dto/, *.spec.ts
      generated/          # Prisma client (sinh ra, không commit)
    prisma/               # schema.prisma, migrations/, seed.ts
    test/                 # e2e test (*.e2e-spec.ts)
  web/                    # Next.js (từ giai đoạn 6)
load-tests/               # kịch bản k6 và script kiểm tra bất biến
docker/                   # cấu hình nginx, prometheus, grafana (khi cần)
docs/
  spec.md                 # đặc tả
  benchmarks.md
  adr/                    # NNNN-english-slug.md
  learning/               # phase-NN-english-slug.md
```

Thư mục chỉ được tạo khi cần đến. Tên file và thư mục bằng tiếng Anh, kebab-case.

## Quy tắc code

- Code, tên biến, comment, commit message, mô tả Swagger: **tiếng Anh**.
- Mọi câu lệnh khóa ở database (`FOR UPDATE`, advisory lock, `UPDATE` có điều kiện) viết bằng **raw SQL có comment**, không giấu sau ORM.
- Không đổi schema bằng tay. Mọi thay đổi đi qua migration Prisma. Partial index và ràng buộc check viết bằng SQL trong migration.
- Mỗi bất biến (I1–I12) phải có ít nhất một test tự động chứng minh.
- Bước chuyển trạng thái đơn: `UPDATE ... WHERE status = <cũ>` rồi kiểm tra số dòng bị ảnh hưởng.
- Không commit secret. Mọi cấu hình đọc từ biến môi trường, validate trong `apps/api/src/config/env.schema.ts`, và có trong `.env.example`.
- Module chỉ gọi service công khai của module khác, không truy vấn bảng của module khác.
- TypeScript strict, ESM: import nội bộ phải có đuôi `.js`.
- Commit nhỏ, theo Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`, `ci:`).

## Tài liệu

- `docs/` (đặc tả, ADR, benchmark, ghi chú học tập): **tiếng Việt**.
- README: `README.md` (tiếng Anh) và `README.vi.md` (tiếng Việt), cập nhật cả hai trong cùng một commit.
- Quyết định kỹ thuật đáng kể: một ADR trong `docs/adr/` (bối cảnh, quyết định, phương án đã loại, hệ quả).
- Cuối mỗi giai đoạn: một ghi chú trong `docs/learning/` gồm đã làm gì, vì sao, lỗi đã gặp, và câu hỏi phỏng vấn có thể gặp.

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

Cổng trên máy chủ dự án:
- PostgreSQL: `5433` (máy đã có PostgreSQL chiếm 5432).
- Redis: `6379`.
- API: `API_PORT` trong `.env`. Máy chủ dự án đặt `3100`, vì 3000 đã bị dự án khác chiếm.

## Skill

Skill trong `.claude/skills/` là **tài liệu tham khảo**, không phải quy trình bắt buộc. Chỉ dùng khi việc đang làm thật sự cần đến, ví dụ:
- Tra API của Prisma 7 trong `prisma-client-api`.
- Tự phản biện một quyết định khóa ghế bằng `doubt-driven-development`.
- Rà checklist bảo mật khi làm phần auth bằng `security-and-hardening`.

Việc nhỏ và rõ ràng thì làm thẳng, không cần qua skill. Nguồn gốc các skill ghi ở `.claude/skills/README.md`.

Khi dùng `doubt-driven-development`: máy không có Gemini hay Codex CLI, nên bỏ qua bước review chéo khác model và chỉ cần báo một dòng.
