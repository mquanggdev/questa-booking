# Giai đoạn 1: Dữ liệu, xác thực, module danh mục

## Đã làm

- **Schema và migration** cho 9 bảng: `users`, `refresh_tokens`, `concerts`, `performances`, `sale_phases`, `zones`, `seats`, `orders`, `order_items`. Có thêm ràng buộc check cơ bản.
- **Xác thực:**
  - Đăng ký, đăng nhập, refresh token xoay vòng có phát hiện dùng lại, đăng xuất, `GET /users/me`.
  - Hai guard toàn cục: xác thực (mặc định bắt buộc) và vai trò (`@Roles`).
- **Danh mục:**
  - Tạo và xem concert.
  - Tạo đêm diễn kèm khu, sơ đồ ghế sinh tự động và đợt mở bán, tất cả trong một transaction.
  - Sửa và công bố đêm diễn; xem sơ đồ ghế và số vé còn lại.
- **Nền chung:** định dạng lỗi thống nhất, validate input, Swagger tại `/api/docs`.
- **Seed:**
  - 5.002 tài khoản, 16.100 ghế, chạy trong khoảng 4 giây.
  - Ghi token cho k6 ra `load-tests/data/`.
- **Test:** 12 unit test và 29 e2e test, chạy trên database `questa_test` riêng.

## Vì sao

### Access token ngắn, refresh token dài

- Access token là JWT: API chỉ cần kiểm chữ ký, không tra DB, nên nhanh và chạy được trên nhiều instance. Đổi lại, nó không thu hồi được, nên phải cho sống ngắn (15 phút).
- Refresh token sống 7 ngày nên phải thu hồi được, vì vậy nó được lưu trong DB.

### Vì sao refresh token nằm trong cookie `httpOnly`

JavaScript của trang không đọc được cookie `httpOnly`. Nếu trang dính lỗi XSS, kẻ tấn công lấy được access token (sống 15 phút) nhưng không lấy được refresh token (sống 7 ngày).

Cookie có thêm hai thuộc tính:
- `SameSite=Strict`: chặn CSRF.
- `Path=/api/v1/auth`: cookie chỉ được gửi tới các endpoint xác thực, không đi kèm mọi request.

### Xoay vòng và phát hiện dùng lại

Mỗi refresh token chỉ dùng được một lần. Giả sử kẻ tấn công trộm được token và dùng nó trước. Khi người dùng thật dùng lại token cũ đó, hệ thống thấy một token đã bị thu hồi lại được gửi lên. Đó là dấu hiệu bị lộ, nên hệ thống thu hồi cả "family" và cả hai bên đều phải đăng nhập lại. Kẻ tấn công mất quyền truy cập.

### Câu `UPDATE` có điều kiện thay cho đọc rồi ghi

```sql
UPDATE refresh_tokens SET revoked_at = now()
WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
RETURNING ...
```

Nếu viết kiểu "đọc token, thấy còn hiệu lực, rồi thu hồi", thì hai request đến cùng lúc đều đọc thấy "còn hiệu lực" và cùng được cấp token mới. Câu `UPDATE` có điều kiện thì nguyên tử: PostgreSQL khóa dòng, và request thứ hai thấy `revoked_at` đã có giá trị nên không khớp.

Đây chính là kỹ thuật dự án sẽ dùng để chống bán trùng ghế ở giai đoạn 3. Có e2e test chứng minh: hai refresh song song thì đúng một request thành công.

### Chống dò email

Đăng nhập bằng email không tồn tại vẫn chạy argon2 với một hash giả, nên mất cùng thời gian và trả cùng thông báo lỗi như sai mật khẩu. Kẻ tấn công không dùng form đăng nhập để dò email nào đã đăng ký được.

### UUID v7

UUID v4 ngẫu nhiên nên mỗi lần insert rơi vào một chỗ bất kỳ trong index, làm index bị chia trang liên tục. UUID v7 có phần đầu là thời gian, nên insert gần như nối đuôi, nhanh như số tự tăng mà vẫn không đoán được.

## Lỗi và chỗ đáng chú ý

| Vấn đề | Cách xử lý |
| --- | --- |
| Tách module concert và đêm diễn thì chúng phụ thuộc vòng lẫn nhau | Gộp thành một module có hai controller, vì đây là một aggregate |
| Sắp ghế theo chữ cái trong SQL đặt "AA" trước "B" | Sắp lại trong code theo độ dài nhãn hàng rồi mới tới chữ cái; có e2e test cho hàng thứ 27 |
| Lỗi thu hồi family bị rollback nếu nằm chung transaction với request lỗi | Thu hồi family ngoài transaction |
| Seed băm 5.000 mật khẩu bằng argon2 sẽ mất vài phút | Băm một lần, dùng chung cho mọi tài khoản thử |
| Sơ đồ 8.000 ghế là 1,1 MB JSON | Ghi nhận, tối ưu ở giai đoạn 7a |

## Câu hỏi phỏng vấn có thể gặp

1. Lưu JWT ở đâu trên trình duyệt thì an toàn? `localStorage` khác cookie `httpOnly` thế nào?
2. Refresh token rotation là gì? Làm sao phát hiện refresh token bị đánh cắp?
3. Vì sao refresh token băm bằng SHA-256 mà mật khẩu lại phải dùng argon2 hoặc bcrypt?
4. Hai request cùng dùng một refresh token đến cùng lúc thì chuyện gì xảy ra? Code của bạn xử lý thế nào?
5. Authentication khác authorization thế nào? Kiểm tra quyền sở hữu tài nguyên đặt ở guard hay ở service, và vì sao?
6. UUID v4 và UUID v7 khác nhau thế nào khi dùng làm khóa chính?
7. Vì sao tiền không nên lưu bằng số thực?
8. Vì sao e2e test nên chạy trên DB thật thay vì mock ORM?
