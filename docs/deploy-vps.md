# Deploy bản demo online lên VPS

Bản demo chạy toàn bộ stack trên VPS (3 vCPU, 3,5 GB RAM), cạnh dự án thương mại điện tử đang có, theo [ADR-0014](adr/0014-defer-online-deploy.md) và [ADR-0018](adr/0018-monitoring-and-deploy.md).

- **CI build image, không build trên VPS.** Workflow `Deploy` (`.github/workflows/deploy.yml`) chạy khi đẩy một tag `v*` hoặc khi bấm tay. Nó build ba image (`questa-booking-api`, `-migrate`, `-web`), đẩy lên `ghcr.io/mquanggdev`, rồi SSH vào VPS chạy `deploy/deploy.sh <git sha>`.
- `deploy.sh` kéo image về, khởi động stack (migration chạy trước), chờ API trả lời qua Nginx của stack. Nếu bản mới không khỏe thì quay về tag trước. Toàn bộ quy trình đã được tập dượt ở local: deploy bình thường, deploy một image hỏng rồi tự quay về, chạy seed demo, định tuyến qua network dùng chung.
- Lúc rảnh, stack dùng khoảng 1 GB RAM (Kafka khoảng 450 MB).

## Việc làm một lần

Thứ tự quan trọng: làm sai thứ tự có thể làm Nginx của dự án kia không khởi động được.

### 1. Tên miền

Tạo hai bản ghi DNS `A` trỏ về IP của VPS, ví dụ `booking.<tên miền>` và `grafana.<tên miền>`.

### 2. Nginx của VPS (trong repo dự án thương mại điện tử)

1. Thêm network dùng chung (ví dụ `edge`) vào compose của dự án kia và gắn container Nginx vào network đó (`external: true`). Tạo network trên VPS một lần: `docker network create edge`. Từ đó về sau, `deploy.sh` tự tạo nếu chưa có.
2. Thêm **chỉ phần cổng 80** trong [`deploy/nginx-vps.conf.example`](../deploy/nginx-vps.conf.example), deploy dự án kia, rồi xin chứng chỉ:
   `certbot certonly --webroot -w /var/www/certbot -d booking.<tên miền> -d grafana.<tên miền>`
   (hoặc theo cách certbot đang chạy trong dự án đó).
3. Khi chứng chỉ đã có, thêm hai server block cổng 443, rồi deploy dự án kia lần nữa.

### 3. Thư mục và file `.env` trên VPS

Workflow SSH vào bằng user dùng cho deploy (ví dụ `deploy`, thuộc nhóm `docker`) và làm việc trong `~/questa-booking` **của user đó**. Vì vậy phải tạo dưới user đó, không phải root (`su - deploy` nếu đang là root).

Lệnh dưới sinh mọi secret ngay trên VPS và ghi thẳng vào file, không hiện ra màn hình; file chỉ chủ sở hữu đọc được và không bao giờ vào git:

```bash
mkdir -p ~/questa-booking && cd ~/questa-booking
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
FAKE_PAYMENT_SECRET=$(openssl rand -hex 32)
GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)
DEMO_ORGANIZER_EMAIL=demo@questa.test
DEMO_ORGANIZER_PASSWORD=demo-$(openssl rand -hex 4)
PUBLIC_BASE_URL=https://booking.<tên miền>
GRAFANA_ROOT_URL=https://grafana.<tên miền>
EDGE_NETWORK=edge
EOF
cut -d= -f1 .env    # chỉ in tên biến để kiểm tra
```

`DEMO_ORGANIZER_PASSWORD` được ghi công khai trong README, vì tài khoản đó chỉ xem được.

Tùy chọn: thêm `VNPAY_TMN_CODE` và `VNPAY_HASH_SECRET` để bật thêm thanh toán qua VNPay sandbox, cạnh cổng giả lập ([vnpay-sandbox.md](vnpay-sandbox.md)).

### 4. GitHub

Trong repo, vào **Settings → Environments**, tạo environment `production` (có thể bật "Required reviewers" để mỗi lần deploy phải bấm duyệt), rồi thêm:

| Loại | Tên | Giá trị |
| --- | --- | --- |
| Secret | `VPS_HOST` | IP hoặc tên máy của VPS |
| Secret | `VPS_USER` | user SSH dùng để deploy (thuộc nhóm `docker`) |
| Secret | `VPS_PORT` | cổng SSH, bỏ trống nếu là 22 |
| Secret | `VPS_SSH_KEY` | private key **riêng cho deploy** (ed25519); public key của nó đặt trong `~/.ssh/authorized_keys` trên VPS |
| Secret | `VPS_KNOWN_HOSTS` | kết quả của `ssh-keyscan -p <cổng> <host>`, để CI kiểm tra đúng là VPS của mình. **Chạy lệnh này trên chính VPS**: bản `ssh-keyscan` đi kèm Windows không thương lượng được thuật toán trao đổi khóa với OpenSSH 8.9 của Ubuntu (`choose_kex: unsupported KEX method`) và không in ra khóa nào |
| Variable | `PUBLIC_URL` | `https://booking.<tên miền>` (bước kiểm tra cuối của workflow) |

Khóa SSH cho CI: tạo một cặp khóa riêng, ví dụ `ssh-keygen -t ed25519 -C github-actions-questa-booking -f ~/.ssh/questa_booking_deploy`, để trống passphrase. Dòng `SHA256:...` mà `ssh-keygen` in ra chỉ là dấu vân tay; thứ cần thêm vào `authorized_keys` là **nội dung file `.pub`** (một dòng bắt đầu bằng `ssh-ed25519`). Kiểm tra bằng `ssh-keygen -lf ~/.ssh/authorized_keys` trên VPS.

GHCR mặc định tạo package ở chế độ riêng tư, nên **lần chạy workflow đầu tiên dừng ở bước kéo image** (`deploy.sh` dừng trước khi khởi động gì cả). Khi đó vào **Packages** trên GitHub, chuyển ba package `questa-booking-*` sang **Public**, rồi **Re-run failed jobs**.

### 5. Deploy lần đầu và dữ liệu demo

1. Chạy workflow `Deploy` bằng tay (Actions → Deploy → Run workflow), hoặc đẩy tag phiên bản.
2. Chạy seed demo **một lần**. Seed không xóa gì, và tự dừng nếu đã có dữ liệu:

   ```bash
   cd ~/questa-booking
   IMAGE_TAG=$(cat .deployed-tag) docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/demo-seed.js | tee presale-codes.txt
   ```

   Seed in ra 100 mã ưu tiên của đêm "Questa Fan Club Night", mỗi mã dùng một lần, và `tee` lưu chúng vào `presale-codes.txt`.
3. Kiểm tra bằng tài khoản demo: header có nhãn "Demo · chỉ xem", trang "Theo dõi mở bán" của từng đêm diễn có số liệu, và `POST /api/v1/concerts` trong Swagger trả `403 DEMO_READ_ONLY`.

## Những điều nên biết

- **Migration không bao giờ được quay ngược.** Khi `deploy.sh` quay về bản cũ, DB vẫn giữ schema mới. Vì vậy mỗi migration phải tương thích với code của bản trước: thêm cột hoặc bảng trước, rồi mới xóa cái cũ ở một bản sau (expand rồi contract).
- **Email của bản demo** được Mailpit giữ lại và không công khai, để địa chỉ email của người dùng thử không bị lộ.
- **Kafka** giới hạn heap 256 MB và giữ log 7 ngày.
- **Console của trình duyệt** có thể hiện lỗi 401 của `POST /api/v1/auth/refresh` khi chưa đăng nhập (web thử khôi phục phiên từ cookie), và cảnh báo "WebSocket is closed before the connection is established" khi rời một trang đêm diễn lúc kết nối realtime còn đang bắt tay. Cả hai đều bình thường.
