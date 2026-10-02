# ADR-0004: Xác thực bằng JWT ngắn hạn và refresh token xoay vòng trong cookie

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 1

## Bối cảnh

Cần đăng nhập cho 3 vai trò, chạy được trên nhiều instance API (không giữ session trong bộ nhớ), an toàn trước XSS, và chịu được khi refresh token bị lộ. Web (Next.js) và API sẽ ở chung một domain sau Nginx.

## Quyết định

1. **Access token** là JWT ký HS256, sống 15 phút, chứa `sub` (user id) và `role`. Client gửi qua header `Authorization: Bearer`. API kiểm tra chữ ký, không cần tra DB, nên mọi instance đều xác thực được.
2. **Refresh token** là chuỗi ngẫu nhiên 256-bit, **không phải JWT**.
   - DB chỉ lưu SHA-256 của token.
   - Token nằm trong cookie `httpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`.
3. **Xoay vòng**: mỗi lần refresh thì thu hồi token cũ và cấp token mới cùng `family_id`.
   - Thu hồi bằng một câu `UPDATE ... WHERE revoked_at IS NULL ... RETURNING` (raw SQL). Nếu hai request refresh cùng token đến song song, đúng một request thắng.
4. **Phát hiện dùng lại**: có ai gửi một token đã bị thu hồi thì thu hồi **cả family**, và người dùng phải đăng nhập lại.
   - Việc thu hồi family chạy **ngoài** transaction, để nó vẫn được lưu dù request đó trả lỗi.
5. **Mật khẩu** băm bằng argon2id.
   - Khi email không tồn tại, hệ thống vẫn chạy `verify` với một hash giả. Nhờ vậy email sai và mật khẩu sai mất cùng thời gian và nhận cùng thông báo lỗi, kẻ tấn công không dò được email nào đã đăng ký.
6. **Phân quyền**:
   - Guard xác thực áp dụng cho mọi route theo mặc định, route công khai phải đánh dấu `@Public()`.
   - Guard vai trò đọc `@Roles()`.
   - Quyền sở hữu (ban tổ chức chỉ sửa được concert của mình) kiểm tra ở tầng service.
7. **Không dùng Passport.** `@nestjs/jwt` cộng hai guard ngắn đã đủ, và dễ đọc hiểu hơn khi học.

## Phương án đã loại

| Phương án | Lý do loại |
| --- | --- |
| Lưu cả access và refresh token trong `localStorage` | Một lỗi XSS là mất cả hai token |
| Refresh token cũng là JWT | Không thu hồi được khi chưa hết hạn, trừ khi lại tra DB; khi đó lợi thế "không cần DB" không còn |
| Băm refresh token bằng argon2 | Thừa. argon2 chậm là để chống đoán mật khẩu yếu; token 256-bit ngẫu nhiên không đoán được, SHA-256 là đủ và tra theo hash rất nhanh |
| Session lưu trong Redis | Cũng tốt, nhưng mọi request đều phải gọi Redis; JWT ngắn hạn kết hợp refresh xoay vòng là mô hình phổ biến hơn trong tin tuyển dụng |
| Passport (`passport-jwt`) | Thêm một lớp trừu tượng và hai thư viện, không thêm khả năng nào cần cho dự án |

## Hệ quả

- **Thu hồi access token không tức thì.** Access token bị lộ vẫn dùng được tối đa 15 phút. Đây là đánh đổi có chủ đích.
- **Hai tab cùng refresh đúng một lúc có thể bị đăng xuất**, vì tab chậm hơn bị coi là dùng lại token. Có thể thêm khoảng ân hạn vài giây nếu thực tế cần; hiện chưa làm.
- **Cookie `Secure` phải bật khi chạy HTTPS** (`COOKIE_SECURE=true` ở production).
- **Endpoint `GET /users/me`** được thêm ngoài đặc tả ban đầu. Nó rất nhỏ, và web cần nó để biết ai đang đăng nhập.
