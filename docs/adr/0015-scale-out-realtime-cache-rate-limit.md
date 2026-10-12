# ADR-0015: Nhiều instance sau Nginx, sơ đồ ghế realtime, cache danh mục, rate limit

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-12
- Giai đoạn: 7a

## Bối cảnh

Đến giai đoạn 6, API chỉ chạy **một tiến trình**. Giai đoạn 7a yêu cầu bốn việc (đặc tả, mục 10):

- chạy 2 instance API sau Nginx và kiểm tra lại toàn bộ bất biến;
- sơ đồ ghế realtime qua WebSocket, theo cơ chế bản chụp kèm `seq`;
- cache cho API đọc danh mục, xóa cache khi sửa;
- rate limit, bộ đếm lưu trong Redis.

Định nghĩa hoàn thành: hai trình duyệt nối vào hai instance khác nhau đều thấy ghế đổi trạng thái (test bằng Playwright), và tắt một instance giữa lúc load test không gây vi phạm bất biến.

Điều khó nhất là **khi có nhiều tiến trình, mọi trạng thái nằm trong RAM của một tiến trình đều sai**: phòng WebSocket, bộ đếm rate limit, cache. Và các thay đổi của ghế xảy ra ở nhiều nơi cùng lúc: API giữ vé, IPN thanh toán, worker nhả vé hết hạn, worker hủy đêm diễn.

## Quyết định

### 1. Nginx là cửa vào duy nhất, API chạy nhiều bản sao

- `docker compose` chạy `api` với `deploy.replicas` (mặc định 2), không mở cổng trực tiếp. Nginx nhận cả hai cổng `WEB_PORT` và `API_PORT`, chuyển `/` sang web, `/api` và `/socket.io` sang các bản sao API theo vòng tròn (round robin).
- `server api:3000 resolve` (có trong Nginx mã nguồn mở từ 1.27.3): Nginx đọc lại DNS của Docker. Bản sao khởi động lại với IP mới vẫn được nhận, và Nginx khởi động được kể cả khi tên chưa tra được.
- Request **POST không bao giờ được Nginx gửi lại** sang bản sao khác khi bản sao đầu chết giữa chừng (mặc định của `proxy_next_upstream`), nên không có chuyện một lần giữ vé bị gửi hai lần.
- `proxy_connect_timeout 2s`: IP của bản sao đã chết không trả lời gì, nên với mặc định 60 s, request sẽ treo 60 s rồi mới được chuyển sang bản sao khác. DNS được đọc lại mỗi 30 s, không phải 5 s: nếu Nginx đọc lại DNS và gỡ bản sao chết đúng lúc request đang kết nối, nhóm upstream chỉ còn 1 server, mà Nginx không thử lại khi chỉ có 1 server. Cửa sổ đua là timeout chia cho chu kỳ đọc DNS, khoảng 7%.
- Cập nhật ở giai đoạn 7b ([ADR-0016](0016-presale-codes-and-waiting-room.md), mục 4): `max_fails=3 fail_timeout=10s` thay cho `max_fails=1`, Node giữ kết nối keep-alive lâu hơn Nginx (65 s so với 60 s), và backlog của `listen` là 4096. Với cấu hình cũ, một cú dồn tải lúc mở bán khiến Nginx đánh dấu cả 2 instance khỏe là chết.
- API tin `X-Forwarded-For` **chỉ khi request đến từ proxy trong mạng nội bộ** (`trust proxy: loopback, uniquelocal`). Khách từ Internet không giả được IP bằng cách tự gửi header.
- Mỗi response có `X-Instance` (tên container) để test và demo thấy được việc cân bằng tải.

### 2. Sơ đồ ghế realtime: một tiến trình phát duy nhất, đọc trạng thái hiện tại

**Cách làm dễ nghĩ ra nhất là sai.** Nếu mỗi nơi tự gom thay đổi thành lô rồi tự đánh `seq`, các lô có thể đến trình duyệt sai thứ tự. Ví dụ: lô "ghế được giữ" gom muộn lại mang `seq` lớn hơn lô "ghế được nhả" xảy ra sau nó, và sơ đồ hiện ghế đang giữ trong khi ghế đã trống.

Cách đã chọn:

1. **Ghi nhận** (mọi bản sao API và worker): sau khi transaction commit, chỉ đánh dấu ghế hoặc khu vừa đổi vào một set Redis của đêm diễn (`seats:dirty:<id>`). Không gửi gì đi.
2. **Phát** (một tiến trình duy nhất trong worker, có khóa Redis): mỗi `SEAT_BROADCAST_EVERY_MS` (mặc định 250 ms, đặc tả yêu cầu 200–500 ms), với mỗi đêm diễn có đánh dấu:
   - một script Lua **lấy và xóa các đánh dấu, đồng thời tăng `seq`** một cách nguyên tử;
   - **đọc trạng thái hiện tại** của các ghế và khu đó từ PostgreSQL;
   - phát lô `seats.batch { seq, seats, zones }` qua `@socket.io/redis-emitter`.
3. **Chuyển đến client:** mỗi bản sao API dùng **Redis adapter** của Socket.IO, nên lô phát từ worker tới được socket nối vào bất kỳ bản sao nào.
4. **Bản chụp** (`GET /performances/:id/seats`) **đọc `seq` trước, rồi mới đọc ghế.**

Vì sao đúng:

- **Bản chụp không bỏ sót.** Một thay đổi có `seq ≤ S` thì đã được đánh dấu, mà đánh dấu luôn sau commit, và `seq` tăng sau khi lấy đánh dấu. Bản chụp đọc `S` rồi mới truy vấn ghế, nên câu truy vấn đó chắc chắn thấy thay đổi đã commit.
- **Sơ đồ cuối cùng luôn đúng.** Lô `N` đọc trạng thái **sau** khi tăng `seq`, và chỉ có một tiến trình phát, nên thay đổi cuối cùng của một ghế luôn có mặt trong một lô có `seq` lớn hơn mọi lô cũ hơn nó.
- **Client** chỉ áp các lô có `seq` lớn hơn của mình, theo đúng thứ tự `+1`. Thấy hụt `seq` thì tải lại bản chụp. Áp một lô hai lần không sao, vì lô chứa trạng thái chứ không chứa phép thay đổi.

Ở trình duyệt, các lô đã nhận được giữ lại một thời gian. Như vậy một bản chụp lỡ trả về **sau** khi đã áp lô mới hơn (request tải lại bản chụp bắt đầu trước, về sau) được kéo lên lại, không làm sơ đồ lùi về trạng thái cũ.

Thay đổi so với đặc tả: sự kiện `zone.updated` được gộp vào `seats.batch` (trường `zones`), để ghế và khu dùng chung một `seq`.

### 3. WebSocket chỉ dùng transport `websocket`

Long-polling gồm nhiều request HTTP nối tiếp, và chúng phải đến **cùng một bản sao**, tức cần sticky session ở Nginx. Chỉ dùng WebSocket thì một kết nối nằm trọn trên một bản sao, nên không cần sticky session.

### 4. Guard xác thực hiểu cả WebSocket

Guard toàn cục (`APP_GUARD`) áp cho cả gateway, trong khi guard cũ chỉ đọc header HTTP. Ở ngữ cảnh WebSocket, giờ guard đọc token từ `handshake.auth.token` (chuẩn của Socket.IO), lưu user vào `socket.data`, và báo lỗi bằng `WsException`. Gateway sơ đồ ghế là `@Public()`, giống API sơ đồ ghế.

### 5. Cache danh mục: lưu bản ghi gốc, áp quy tắc hiển thị khi đọc

- Cache-aside trong Redis cho danh sách concert, chi tiết concert, chi tiết đêm diễn. TTL `CATALOG_CACHE_TTL_SECONDS` (mặc định 60 s; đặt `0` thì tắt).
- **Cache bản ghi gốc** (có cả bản nháp), và quyết định "ai được thấy gì" **sau khi đọc**. Một mục cache phục vụ được cả ban tổ chức lẫn khách, và **bản nháp không thể lộ qua cache**.
- **Mọi thao tác ghi qua API đều xóa cache:** xóa đúng các mục chi tiết bị ảnh hưởng, còn danh sách thì tăng số phiên bản, nên mọi trang danh sách cũ tự bị bỏ qua.
- **Số vé còn lại không bao giờ được cache.** Nó nằm ở API sơ đồ ghế, vốn luôn đọc mới và có realtime.
- **Redis lỗi thì đọc thẳng database** (fail-open).

### 6. Rate limit: `@nestjs/throttler` với storage Redis tự viết

- **Hai bộ giới hạn:** `ip` cho mọi request, theo IP thật; `user` cho request đã đăng nhập, theo tài khoản (mặc định 300 và 120 request/phút).
- **Giới hạn chặt hơn:** `/auth/login` 10 lần/phút/IP (chống dò mật khẩu), `/reservations` 20 lần/phút/tài khoản.
- **Storage là một script Lua nguyên tử** (cửa sổ cố định kèm khóa chặn). Bộ đếm trong RAM sẽ cho mỗi bản sao một hạn mức riêng: 2 bản sao thì gấp đôi giới hạn. Test chứng minh điều này: đổi sang bộ đếm trong RAM thì test hỏng.
- Theo mặc định của thư viện, bộ đếm tính **theo từng route**.
- **Load test tắt rate limit** (`RATE_LIMIT_ENABLED=false`), vì mọi người dùng ảo của k6 đi từ một IP. `run.mjs` ghi lại cấu hình này và từ chối đo nếu nó đang bật.

## Phương án đã loại

- **Mỗi bản sao tự đánh `seq` cho lô của mình.** Sai thứ tự, như phân tích ở mục 2.
- **Gửi ngay từng thay đổi kèm trạng thái mới, không đọc lại database.** Hai thay đổi của cùng một ghế từ hai tiến trình có thể đến sai thứ tự.
- **Gửi thẳng từ transaction** (trước commit hoặc trong lúc commit). Client có thể thấy một trạng thái mà rồi bị rollback.
- **Sticky session thay vì chỉ dùng WebSocket.** Thêm cấu hình Nginx mà không được lợi gì, vì mọi trình duyệt hiện đại đều có WebSocket.
- **Thư viện storage Redis của bên thứ ba cho throttler.** Chỉ cần khoảng 30 dòng tự viết, và giải thích được từng dòng.
- **Cache theo từng người xem** (mỗi người xem một mục). Nhiều mục hơn, và việc xóa cache khi sửa sẽ phức tạp hơn nhiều.

## Hệ quả

- Kết quả đo (2 instance và 1 instance, giết một instance giữa chừng, cache tắt và bật): xem [benchmark](../benchmarks.md).
- **Test tự động:**
  - test hội tụ: client vào giữa lúc 24 khách giữ vé song song vẫn khớp database đến từng ghế; đổi thứ tự đọc `seq` thì test hỏng;
  - Playwright: hai trình duyệt nối vào hai bản sao khác nhau cùng thấy ghế đổi trạng thái; bỏ Redis adapter thì test hỏng;
  - test cache và rate limit, mỗi test đều đã được thử ngược.
- **Đánh dấu "ghế vừa đổi" là best effort.** Nếu Redis lỗi đúng lúc đó, hoặc tiến trình chết ngay sau khi commit, client chỉ thấy thay đổi ở lần tải lại bản chụp tiếp theo (30 s, hoặc khi kết nối lại). Tính đúng của việc bán vé không bị ảnh hưởng.
- **Cache có thể cũ tối đa một TTL (60 s)** trong trường hợp đua hiếm: đọc bản ghi cũ, rồi bị xóa cache, rồi ghi bản ghi cũ vào lại cache.
- Bản online (giai đoạn 9) chạy cùng cấu hình này sau Nginx của VPS ([ADR-0014](0014-defer-online-deploy.md)).
