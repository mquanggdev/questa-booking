# Showcase

Mỗi giai đoạn được diễn giải theo 3 cách, cho người mới cũng hiểu được:

| | Ở đâu | Xem thế nào |
| --- | --- | --- |
| **Sơ đồ** | `phase-NN/README.md` (Mermaid) | Mở file trên GitHub, sơ đồ tự hiển thị |
| **Trang demo** | `phase-NN/index.html` | `docker compose up -d` rồi `pnpm showcase`, mở <http://localhost:4100> |
| **Video tiếng Việt** | `phase-NN/video/phase-NN.mp4` | Mở trực tiếp, hoặc xem ngay trong trang demo (có phụ đề) |

## Các giai đoạn

| Giai đoạn | Sơ đồ | Video |
| --- | --- | --- |
| 1. Dữ liệu, xác thực, danh mục | [phase-01/README.md](phase-01/README.md) | [phase-01.mp4](phase-01/video/phase-01.mp4) |

## Cách hoạt động

- `server.mjs` là một server Node nhỏ, không dùng thư viện ngoài. Nó phục vụ các trang trong thư mục này và chuyển `/api/*` sang API thật, nên trang demo và API chung một origin, và cookie refresh hoạt động giống như khi chạy sau Nginx. Server này chỉ dùng khi phát triển, không deploy.
- Trang demo đọc sơ đồ trực tiếp từ `README.md` của giai đoạn, nên sơ đồ chỉ có một nguồn.
- Kịch bản nhiều bước mà trình duyệt không tự làm được (ví dụ gửi lại một cookie `httpOnly` cũ) nằm trong `phase-NN/scenarios.mjs` và chạy phía server.

## Làm lại video

```bash
pnpm showcase:video docs/showcase/phase-01/video/slides.html
```

Script `tools/make_video.py` làm các bước sau:
1. Mở `slides.html` bằng Microsoft Edge (Playwright) và chụp từng slide ở 1280×720.
2. Đọc lời thoại trong `data-narration` bằng giọng tiếng Việt `vi-VN-HoaiMyNeural` (edge-tts).
3. Ghép thành MP4 bằng ffmpeg, kèm phụ đề `.vtt` và `.srt`.

Mọi công cụ chạy qua `uv`, không cài gì lên hệ thống.

Lưu ý: lời thoại được gửi tới dịch vụ đọc của Microsoft Edge để tổng hợp giọng nói. Lời thoại chỉ chứa phần giải thích dự án, không chứa dữ liệu nhạy cảm.

Muốn xem trước slide, chạy `pnpm showcase` rồi mở `/phase-NN/video/slides.html`. Thêm `?slide=3` để xem riêng một slide.
