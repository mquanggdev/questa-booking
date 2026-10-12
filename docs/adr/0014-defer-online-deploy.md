# ADR-0014: Dời deploy online sang giai đoạn 9

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-12
- Giai đoạn: 6

## Bối cảnh

Đặc tả ban đầu đặt "deploy cơ bản lên một VPS bằng Docker Compose" vào giai đoạn 6, và định nghĩa hoàn thành là "mua được vé trên bản demo online". Khi bắt tay vào làm thì gặp mấy điều kiện thực tế:

- **VPS sẵn có rất nhỏ và đang chạy một dự án khác** của tác giả (một trang thương mại điện tử, đang phục vụ người dùng):
  - 1 vCPU, 957 MB RAM, ổ 24 GB;
  - lúc đo chỉ còn khoảng 411 MB RAM dùng được, và swap đã bị dùng 219 MB;
  - dự án kia giữ cổng 80/443 bằng container Nginx kèm certbot, và cấu hình Nginx do CI/CD của chính dự án đó chép lên VPS ở mỗi lần deploy.
- **Nếu chạy toàn bộ Booking trên VPS**, cần thêm khoảng 350–550 MB: PostgreSQL, Redis, API, worker, web. Như vậy là vượt RAM còn trống.
- **Giá trị chính của dự án không xem được trên bản online**: không bán trùng khi 5.000 khách tranh 100 ghế, IPN gửi trùng hoặc muộn không làm mất tiền, thông lượng tăng nhờ Redis. Những điều đó được chứng minh bằng load test, test tự động và ADR, đều chạy ở local (đặc tả, mục 9). Bản online chỉ chứng minh luồng mua vé chạy được.
- **Kỹ năng triển khai đã có bằng chứng ở dự án kia**: Docker, Nginx, HTTPS, CI/CD qua GHCR, tự quay về bản cũ khi deploy lỗi.

## Quyết định

**Giai đoạn 6 kết thúc ở local.** Deploy online chuyển thành mục đầu tiên của giai đoạn 9. Hạ tầng sẽ được chốt ở đầu giai đoạn 9.

Định nghĩa hoàn thành mới của giai đoạn 6:
- mua được vé trên trình duyệt với stack dựng bằng `docker compose up`;
- test Playwright của luồng mua vé xanh trong CI, chạy trên **toàn bộ stack Docker**;
- README có ảnh động của luồng mua vé.

Để người xem không cần tự chạy vẫn tin được dự án, README dựa vào: ảnh động luồng mua vé, badge CI (CI dựng cả stack và chạy trình duyệt thật ở mỗi lần push), bảng benchmark, và các ADR.

## Phương án đã loại

- **Chạy toàn bộ trên VPS hiện tại.** Không đủ RAM. Máy sẽ swap nhiều, chậm, và có thể kéo chậm dự án đang phục vụ người dùng.
- **Web trên Vercel, backend trên VPS, deploy ngay.** Vừa RAM, không tốn thêm tiền. Nhưng phải sửa reverse proxy của dự án kia ngay bây giờ (rủi ro được nêu ở dưới), và chưa đem lại giá trị chứng minh nào mới trước khi các giai đoạn 7a, 7b, 8 hoàn thành. Phương án này vẫn là ứng viên cho giai đoạn 9.
- **Chuyển dự án thương mại điện tử sang nền tảng miễn phí để nhường VPS.** Dự án đó dùng Express với Pug (render phía server), Socket.IO, `node-cron`, session lưu trong RAM, file upload trên ổ đĩa và Puppeteer.
  - Vercel (serverless) không chạy được những thứ này nếu không viết lại.
  - Render gói miễn phí: service ngủ sau 15 phút, mất ảnh upload sau mỗi lần khởi động lại, có thể lỡ job định kỳ và callback thanh toán.
  - Railway thì chạy tốt nhưng tốn tiền, đắt hơn VPS đang thuê.

  Chuyển đi sẽ làm hỏng chính bằng chứng về kỹ năng vận hành của dự án đó.
- **Railway hoặc Render cho cả Booking.** Tốn tiền hằng tháng, hoặc gói miễn phí không chạy được worker liên tục: thiếu worker thì vé hết hạn không được nhả và tiền về muộn không được hoàn.
- **Không bao giờ deploy Booking.** Bỏ mất đường link "bấm là thấy" ở bản hoàn chỉnh.

## Những điều phải nhớ khi deploy ở giai đoạn 9

Đây là kết quả khảo sát VPS, ghi lại để không phải tìm lại:

1. **Trùng tên project Docker Compose.** Container của dự án kia đang tên `questa-*`, tức project Compose của nó tên `questa`. Booking trên VPS phải dùng tên riêng (ví dụ `questa-booking`). Nếu không, `docker compose up` sẽ coi container của dự án kia là "mồ côi" và có thể dừng chúng.
2. **Reverse proxy thuộc về dự án kia.** Cấu hình Booking phải nằm trong repo của dự án đó, không sửa tay trên VPS, vì sẽ bị CI/CD của nó ghi đè. Có ba cách làm Nginx không khởi động được, và mỗi cách đều kéo sập cả dự án kia:
   - tên container API của Booking không tra được lúc khởi động → dùng `resolver 127.0.0.11` và đặt địa chỉ đích trong một biến;
   - chưa có chứng chỉ cho subdomain của Booking → chỉ bật server block khi chứng chỉ đã có;
   - network dùng chung chưa tồn tại → script deploy tự tạo network nếu chưa có.
3. **Không build trên VPS** (đặc tả, mục 11). Image API hiện khoảng 826 MB, cần làm gọn. Migration đang chạy bằng image build khoảng 2,6 GB, cần một image nhỏ riêng để chạy `prisma migrate deploy`.
4. **PostgreSQL phải là bản 18**, vì có `uuidv7()`. **Redis phải đặt `noeviction`**, vì BullMQ yêu cầu.
5. **Nếu web chạy trên Vercel:** rewrites của Vercel không chuyển tiếp WebSocket. Realtime của giai đoạn 7a khi đó phải nối thẳng tới domain của API, tức khác origin với web, và cần xác thực bằng token. API phải tin proxy (`trust proxy`) để lấy đúng IP khách.
6. **Hai instance API (giai đoạn 7a) cùng Prometheus và Grafana (giai đoạn 9) không vừa VPS 1 GB.** Hoặc nâng VPS, hoặc bản online chỉ chạy một instance và ảnh dashboard chụp từ local.

## Hệ quả

- Giai đoạn 6 hoàn thành mà chưa có link online. README phải tự thuyết phục bằng ảnh động, CI và số liệu.
- Dự án kia không bị đụng tới ở giai đoạn này.
- Giai đoạn 9 có thêm việc deploy lần đầu, và bắt đầu bằng việc chốt hạ tầng: dùng phân tích ở trên, cộng với cấu hình VPS lúc đó.
- Tag của giai đoạn 6 đổi từ `v3-demo` thành `v3-web`, cho đúng nội dung.
