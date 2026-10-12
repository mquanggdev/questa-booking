# ADR-0016: Mã ưu tiên, hàng chờ ảo, và chịu được cú dồn tải lúc mở bán

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-12
- Giai đoạn: 7b

## Bối cảnh

Giai đoạn 7b yêu cầu ba việc (đặc tả, mục 10): đợt mở bán và mã ưu tiên, hàng chờ ảo, kịch bản k6 `on-sale`. Định nghĩa hoàn thành: có test tự động cho I11, và kịch bản `on-sale` có số liệu, không có vi phạm.

- **I11**: trong đợt bán trước chỉ tài khoản đã kích hoạt mã mới giữ được vé, và mỗi mã chỉ dùng một lần.
- **Hàng chờ ảo**: người mua vào một sorted set trong Redis theo thứ tự đến; worker cho vào từng đợt theo tốc độ cấu hình và cấp vé vào cửa có thời hạn, gắn với tài khoản và đêm diễn; API từ chối giữ vé khi không có vé vào cửa hợp lệ; vị trí được đẩy qua WebSocket.

Đặc tả để ngỏ: ai tạo mã và bằng cách nào, một tài khoản được dùng bao nhiêu mã, cách báo vị trí cho hàng nghìn người, hàng chờ làm gì trước giờ mở bán và khi Redis lỗi.

## Quyết định

### 1. Mã ưu tiên: một câu `UPDATE` có điều kiện, một mã cho mỗi tài khoản mỗi đợt

- Bảng `presale_codes` (`sale_phase_id`, `code` unique, `redeemed_by`, `redeemed_at`). Ban tổ chức sinh mã qua `POST /performances/:id/presale/codes` (tối đa 1.000 mã một lần) và xem lại qua `GET .../presale/codes`. Đặc tả không có endpoint này, nhưng không có nó thì không có mã để phát.
- Mã gồm 10 ký tự từ bảng 30 ký tự, bỏ các ký tự dễ nhầm (0/O, 1/I/L, U), sinh bằng CSPRNG (`crypto.randomInt`): khoảng 49 bit. Mã được hiện dạng `K7QM-2XRP-9D`; khi nhập, bỏ qua hoa thường, dấu cách và gạch ngang.
- Kích hoạt là **một câu lệnh** viết bằng raw SQL:

  ```sql
  UPDATE presale_codes pc SET redeemed_by = $user, redeemed_at = now()
  FROM sale_phases sp
  WHERE pc.code = $code AND pc.redeemed_by IS NULL
    AND sp.id = pc.sale_phase_id AND sp.performance_id = $perf AND sp.ends_at > now()
  RETURNING pc.sale_phase_id, pc.redeemed_at
  ```

  Hai người kích hoạt cùng một mã: đúng một người khớp `redeemed_by IS NULL`.
- **Partial unique index** `(sale_phase_id, redeemed_by) WHERE redeemed_by IS NOT NULL`: một tài khoản chỉ kích hoạt được một mã trong mỗi đợt. Thiếu nó, một tài khoản có thể đốt hết các mã đoán được hay mua được. Câu `UPDATE` vi phạm index thì bị hủy cả câu, nên mã thứ hai vẫn còn nguyên cho người khác.
- Ràng buộc check: `redeemed_by` và `redeemed_at` cùng rỗng hoặc cùng có giá trị. Khóa ngoại tới `users` là `ON DELETE RESTRICT`: xóa tài khoản không được làm một mã đã dùng trở lại "chưa dùng". Prisma mặc định là `SET NULL`.
- Khi câu `UPDATE` không khớp dòng nào, API đọc lại mã để trả lời rõ: `PRESALE_CODE_INVALID` (404, kể cả khi mã thuộc đêm diễn khác, để không lộ là mã có tồn tại), `PRESALE_CODE_USED`, `PRESALE_CLOSED`. Kích hoạt lại chính mã của mình thì trả 200, vì đó là lần gửi lại sau khi mất response.
- Kích hoạt có rate limit riêng: 10 lần mỗi phút cho mỗi tài khoản.

### 2. Kiểm tra quyền mua chạy trước cổng Redis

Thứ tự trong `POST /reservations`:

1. Vé vào cửa của hàng chờ: một lệnh đọc Redis, chỉ khi đêm diễn bật hàng chờ.
2. Mã ưu tiên: đợt đang mở lấy từ cache; **chỉ trong đợt bán trước** mới đọc thêm một dòng có index.
3. Cổng Redis (giai đoạn 4).
4. Trong database (`getOnSale`), kiểm tra lại đợt mở bán và mã ưu tiên một lần nữa. Đây là bước quyết định cuối cùng.

Bản đầu tiên kiểm tra mã ưu tiên ở bước 4, tức **sau** cổng Redis. Khi đó một tài khoản không có mã vẫn chiếm được ghế trong Redis vài mili giây trước khi bị từ chối, và trong khoảng đó khách có mã chọn đúng ghế ấy sẽ nhận "ghế đã có người giữ". Kẻ phá có thể dùng việc này để chặn khách hợp lệ. Test e2e dùng `MONITOR` của Redis để chứng minh request bị từ chối không chạm vào khóa `seat:hold:*`. Khi đảo lại thứ tự cũ, test này hỏng.

Kích hoạt mã là vĩnh viễn, nên kiểm tra trước transaction là đủ: không có cách nào "hủy kích hoạt" trong lúc transaction đang chạy.

**Gửi lại vẫn nhận đơn cũ (I5).** Nếu một bước kiểm tra ở trên từ chối (vé vào cửa đã hết hạn, đợt bán vừa đóng, thiếu mã) nhưng `Idempotency-Key` đã tạo ra một đơn, API trả lại đơn đó với `Idempotent-Replayed: true` thay vì báo lỗi. Truy vấn này chỉ chạy ở nhánh bị từ chối. Trước giai đoạn 7b, gửi lại sau khi đợt bán đóng nhận `SALE_NOT_OPEN`; lỗi đó cũng được sửa luôn.

### 3. Hàng chờ ảo trong Redis, cho vào bằng một job BullMQ duy nhất

- Cột `performances.waiting_room_enabled` do ban tổ chức bật khi tạo hoặc sửa đêm diễn.
- Mỗi đêm diễn có:
  - `wr:<perf>:line`: sorted set, thành viên là `user_id`, điểm là **số thứ tự** (không phải thời điểm, để không có hai người cùng điểm);
  - `wr:<perf>:meta`: hash gồm `seq` (số cuối đã phát) và `served` (số của người cuối cùng đã được vào);
  - `wr:<perf>:pass:<user>`: vé vào cửa, là một key có TTL (`WAITING_ROOM_PASS_TTL_SECONDS`, mặc định 10 phút);
  - `wr:active`: tập các đêm diễn đang có người chờ.
- **Vào hàng** là một script Lua: đã có vé vào cửa thì trả về; đã có trong hàng thì giữ nguyên số; chưa có thì `HINCRBY seq` rồi `ZADD`. Vì nguyên tử, một người bấm 10 lần chỉ nhận một số, và 100 người vào cùng lúc nhận 100 số khác nhau (đã có test).
- **Cho vào**: job lặp `admit-batch` của queue `waiting-room`, mỗi `WAITING_ROOM_TICK_MS`. Với mỗi đêm diễn đang có người chờ, một script Lua lấy `ZPOPMIN` N người đứng đầu, đặt vé vào cửa có TTL và ghi `served`. BullMQ xử lý từng job một, nên chỉ có một nơi cho vào và hai lượt không chồng nhau.
- **Trước giờ mở bán** vẫn vào hàng được, nhưng không ai được cho vào: vé vào cửa sẽ hết hạn trước khi kịp dùng. Ai đến trước giờ mở bán vẫn giữ đúng thứ tự.
- **Vị trí**: worker phát **một** tin `queue.position` `{admittedThrough, waiting}` cho cả hàng mỗi lượt, không phải một tin cho mỗi người. Mỗi người biết số của mình, nên vị trí = `số - admittedThrough`. Con số này chính xác vì hàng là đến trước được vào trước, và chỉ rời hàng khi được cho vào. Người được vào nhận `queue.admitted` riêng, trong phòng của chính mình.
- `GET /queue/me` trả thêm thời gian chờ dự kiến và `pollAfterMs` (mục 5).
- **Redis lỗi thì cho qua** (fail open), như cổng Redis ([ADR-0010](0010-redis-gate-and-expiry.md)): hàng chờ bảo vệ hệ thống và giữ công bằng, không bảo vệ bất biến nào. PostgreSQL vẫn quyết định mọi lượt giữ vé.
- Namespace `/queue` cần đăng nhập (token trong `handshake.auth`), và mỗi người chỉ vào được phòng của chính mình.

### 4. Chịu được cú dồn tải lúc mở bán (tìm ra khi chạy `on-sale`)

Lần chạy `on-sale` đầu tiên có 0 vi phạm, nhưng 28.457 request nhận 502. Có ba nguyên nhân, đều đã được đo và sửa:

1. **Hàng đợi kết nối của Node tràn.** Mặc định backlog của `listen` là 511. Khi 2.000 khách ập vào, kernel bỏ kết nối (`ListenOverflows` khoảng 700 ở mỗi instance), Nginx kết nối quá 2 s và đánh dấu instance là chết. Sửa: backlog 4096, bằng `net.core.somaxconn` của container. Quá tải giờ là chờ, không phải lỗi.
2. **Keep-alive lệch nhau giữa Nginx và Node.** Node đóng kết nối rảnh sau 5 s, Nginx giữ tới 60 s. Request gửi vào đúng kết nối Node vừa đóng nhận RST (`recv() failed (104)`), và với `max_fails=1` thì một instance khỏe bị loại 5 s. Hai lần như vậy loại cả hai instance. Sửa: Node `keepAliveTimeout` 65 s (lớn hơn 60 s của Nginx, để Nginx luôn là bên đóng trước), và `max_fails=3 fail_timeout=10s`.
3. **Ùn tắc khi cache trống.** Lúc mở bán, hàng nghìn request cùng thiếu một mục cache, và mỗi request đều đọc PostgreSQL. Sửa: single flight trong `CatalogCacheService`, mỗi tiến trình chỉ có một lần đọc cho mỗi key.

Lần chạy đầu được giữ trong bảng benchmark làm bằng chứng "trước khi sửa".

### 5. Tốc độ cho vào đặt theo sức chứa đo được, mặc định 50 người/giây

Sau khi sửa mục 4, cho vào 100 người/giây vẫn làm hai instance quá tải trên máy dev: giữ vé p50 3,7 s, có 503 vì pool DB cạn. Đo cho thấy nút thắt là CPU của Node (mỗi lượt giữ vé khoảng 10 truy vấn qua Prisma), không phải số lượt hỏi vị trí. Ở 50 người/giây: giữ vé p50 20 ms, p95 99 ms, 0 lỗi 5xx. Không có hàng chờ: p95 10,7 s, 16% request lỗi 5xx. Vì vậy mặc định là 50, và đây chính là cái núm hàng chờ sinh ra để vặn.

Thời gian chờ dự kiến = thời gian còn lại tới giờ mở bán + `ceil(vị trí / N) × chu kỳ`. `pollAfterMs` = một phần tư thời gian đó, trong khoảng 1–30 s: người đứng xa hỏi thưa, người sắp tới lượt hỏi dày. Trang web nghe WebSocket và chỉ hỏi theo gợi ý này khi mất kết nối.

## Phương án đã loại

- **Kiểm tra mã ưu tiên sau cổng Redis**, như bản đầu tiên: để kẻ không có mã chặn được khách có mã (mục 2).
- **Lưu mã dạng băm.** Mã cần tìm theo giá trị và ban tổ chức cần xem lại để phát; 49 bit cùng rate limit đủ chống đoán. Mã là quyền mua sớm, không phải mật khẩu.
- **Điểm trong sorted set là thời điểm đến.** Hai người cùng mili giây sẽ cùng điểm, và Redis xếp họ theo chuỗi `user_id`, không theo thứ tự đến. Số tăng dần thì không trùng và cho ra vị trí chính xác.
- **Gửi `queue.position` riêng cho từng người.** Với N người chờ là N tin mỗi giây. Một tin cho cả hàng là đủ, vì ai cũng tự tính được vị trí từ số của mình.
- **Cho vào theo sức chứa động** (đếm số vé vào cửa đang còn hiệu lực rồi bù cho đủ). Tự điều chỉnh tốt hơn, nhưng phức tạp hơn và khó giải thích hơn. Tốc độ cố định cộng với số đo là đủ cho giai đoạn này.
- **Redis lỗi thì chặn hết (fail closed).** Không ai mua được đúng lúc đông nhất, trong khi tính đúng vẫn do PostgreSQL giữ.
- **Vé vào cửa dạng token ký gửi cho client.** Vé gắn với tài khoản nằm ở server là đủ, không cần thêm khóa ký, và không ai đưa vé của mình cho người khác dùng được.

## Hệ quả

- I11 có test e2e: 20 tài khoản tranh một mã thì đúng một người được; một tài khoản kích hoạt 6 mã song song thì chỉ được 1; thiếu mã thì 403 và request không chạm vào cổng Redis.
- Hàng chờ có test e2e (đến trước vào trước, cho vào theo lô, vé vào cửa hết hạn, trước giờ mở bán, WebSocket) và test trình duyệt. Thử ngược ba lần (mỗi lần vào hàng cấp số mới, bỏ qua kiểm tra vé vào cửa, cho vào theo thứ tự ngược) đều làm test hỏng.
- `on-sale` có 0 vi phạm I1/I9/I10 ở mọi cấu hình, 0 lượt lách hàng thành công, và 0 khách đã được vào mà bị từ chối.
- Người đang chờ không tải sơ đồ ghế, nên server bớt được một phần tải.
- Redis Cluster sẽ cần hash tag cho các key `wr:<perf>:*`, vì script cho vào ghi các key vé vào cửa do nó tự tạo tên. Hiện dùng một Redis đơn nên chưa cần.
- Số liệu: [benchmark](../benchmarks.md), các dòng 7b.
