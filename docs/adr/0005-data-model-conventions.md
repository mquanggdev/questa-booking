# ADR-0005: Quy ước mô hình dữ liệu

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-02
- Giai đoạn: 1

## Quyết định

| Quy ước | Lý do |
| --- | --- |
| Khóa chính UUID v7, sinh bằng `uuidv7()` của PostgreSQL 18 | UUID v4 ngẫu nhiên nên làm index B-tree bị chia trang liên tục khi insert. UUID v7 tăng dần theo thời gian nên insert gần như nối đuôi, giống số tự tăng, nhưng vẫn không đoán được và không lộ số lượng bản ghi. Sinh ở DB nên câu raw SQL `INSERT` cũng tự có id |
| Bảng và cột `snake_case`, model Prisma `PascalCase` (`@@map`, `@map`) | Viết raw SQL không phải đặt tên trong ngoặc kép; code TypeScript vẫn theo quy ước của nó |
| Tiền là số nguyên VND (`int`) | Số thực có sai số làm tròn. VND không có phần lẻ. Giá tối đa 1 tỷ, một đơn tối đa 20 vé, vẫn nằm trong giới hạn `int` |
| Thời gian `timestamptz` | Lưu theo UTC; client hiển thị theo múi giờ của người xem |
| Enum của PostgreSQL cho các trạng thái | DB tự từ chối giá trị lạ, kể cả khi ghi bằng raw SQL |
| Ràng buộc check cơ bản (giá không âm, sức chứa lớn hơn 0, đợt mở bán có `ends_at > starts_at`) viết bằng SQL trong migration | Prisma không khai báo được check constraint |
| Concert và đêm diễn nằm chung module `concerts` | Đêm diễn không tồn tại nếu không có concert. Tách thành hai module thì chúng phụ thuộc vòng lẫn nhau |

## Cố ý chưa có

- Partial unique index trên `order_items(seat_id) WHERE released_at IS NULL`.
- Check `held_count + sold_count <= capacity` trên `zones`.

Giai đoạn 2 phải tái hiện được lỗi bán trùng, nên hai lớp bảo vệ này chỉ thêm ở giai đoạn 3. Cột `orders.idempotency_key` cũng thêm ở giai đoạn 3.

## Hệ quả

- Ghế được sắp theo thứ tự hàng của nhà hát (A…Z, AA…) trong code, vì sắp theo chữ cái trong SQL sẽ đặt "AA" trước "B".
- `GET /performances/:id/seats` với 8.000 ghế trả về khoảng 1,1 MB JSON trong 65–100 ms trên máy đo. Sẽ tối ưu (định dạng gọn hơn, cache) ở giai đoạn 7a.
