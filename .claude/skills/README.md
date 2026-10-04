# Skill cho agent

Skill ở đây là tài liệu tham khảo: agent chỉ dùng khi việc đang làm thật sự cần đến, không áp dụng máy móc cho mọi việc.

| Skill | Nguồn | Phiên bản |
| --- | --- | --- |
| `test-driven-development`, `doubt-driven-development`, `documentation-and-adrs`, `planning-and-task-breakdown`, `api-and-interface-design`, `security-and-hardening`, `debugging-and-error-recovery`, `source-driven-development` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT, xem `LICENSE.agent-skills`) | commit `9d0c60d` (2026-10-01) |
| `prisma-cli`, `prisma-client-api` | [prisma/skills](https://github.com/prisma/skills) (MIT), lấy qua `prisma init` của Prisma 7.10.0 | skill 7.9.1 |
| `phase-check`, `benchmark` | Viết riêng cho dự án | — |

Skill bên thứ ba được chép nguyên văn, không sửa. Các điều chỉnh cho dự án (ví dụ bỏ qua review chéo khác model trong `doubt-driven-development`) ghi trong `AGENTS.md`, để có thể cập nhật skill mà không mất điều chỉnh.

Các skill không chọn từ agent-skills và lý do:

- `spec-driven-development`, `idea-refine`, `interview-me`, `constraint-driven-development`: đã có đặc tả.
- `incremental-implementation`: hướng dẫn dùng feature flag, dự án không cần.
- `performance-optimization`: thiên về Core Web Vitals; hiệu năng backend đo bằng k6.
- `code-review-and-quality`, `code-simplification`: trùng với `/code-review`, `/simplify` có sẵn trong Claude Code.
- `git-workflow-and-versioning`: quy tắc commit đã nằm trong `AGENTS.md`.
- `ci-cd-and-automation`, `observability-and-instrumentation`, `frontend-ui-engineering`, `shipping-and-launch`: sẽ thêm khi đến giai đoạn cần (6, 9).
