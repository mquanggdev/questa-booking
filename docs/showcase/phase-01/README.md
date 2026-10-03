# Giai đoạn 1: Dữ liệu, xác thực, danh mục

**Demo:** chạy `pnpm showcase` rồi mở <http://localhost:4100/phase-01/> · **Video:** [phase-01.mp4](video/phase-01.mp4) · **Ghi chú học tập:** [phase-01-data-and-auth.md](../../learning/phase-01-data-and-auth.md)

Giai đoạn này dựng phần nền cho mọi thứ phía sau:
- Database chứa concert, đêm diễn, khu và ghế.
- Đăng nhập an toàn với refresh token xoay vòng.
- Phân quyền theo 3 vai trò.
- API để ban tổ chức tạo đêm diễn và khách xem sơ đồ ghế.

Chưa có chức năng đặt vé. Đặt vé bắt đầu từ giai đoạn 2.

## Sơ đồ

### Kiến trúc hiện tại

Một tiến trình NestJS chạy trong Docker, nói chuyện với PostgreSQL. Redis đã kết nối nhưng đến giai đoạn 4 mới dùng.

```mermaid
flowchart LR
  client["Trình duyệt / Swagger / k6"] -->|"HTTP /api/v1"| api
  subgraph api["API NestJS"]
    direction TB
    auth["auth: đăng nhập, refresh, logout"]
    users["users: /users/me"]
    concerts["concerts: concert và đêm diễn"]
    seats["seats: sinh và đọc sơ đồ ghế"]
    health["health: liveness, readiness"]
  end
  api -->|"Prisma 7 + raw SQL"| pg[("PostgreSQL 18")]
  api -.->|"chỉ health check"| redis[("Redis 8")]
```

### Đường đi của một request

Mọi request đi qua cùng một dây chuyền. Lỗi ở bất kỳ bước nào cũng được trả về cùng một dạng `{ code, message, details }`.

```mermaid
flowchart LR
  req(["Request"]) --> jwt{"JwtAuthGuard: có token hợp lệ?"}
  jwt -->|"không, và route không công khai"| e401["401 UNAUTHORIZED"]
  jwt -->|"có, hoặc route @Public"| roles{"RolesGuard: đúng vai trò?"}
  roles -->|"không"| e403["403 FORBIDDEN"]
  roles -->|"có"| pipe{"ValidationPipe: body hợp lệ?"}
  pipe -->|"không"| e400["400 VALIDATION_FAILED + từng field"]
  pipe -->|"có"| ctrl["Controller"] --> svc["Service: quy tắc nghiệp vụ, quyền sở hữu"]
  svc --> db[("PostgreSQL")]
  svc -->|"AppException"| filter["AllExceptionsFilter"]
  filter --> err["{ code, message, details }"]
```

### Mô hình dữ liệu

9 bảng. `orders` và `order_items` đã có, nhưng đến giai đoạn 2 mới được dùng.

```mermaid
erDiagram
  users ||--o{ refresh_tokens : "có"
  users ||--o{ concerts : "tổ chức"
  users ||--o{ orders : "đặt"
  concerts ||--|{ performances : "gồm các đêm"
  performances ||--|{ sale_phases : "mở bán theo đợt"
  performances ||--|{ zones : "chia khu"
  zones ||--o{ seats : "chứa ghế (khu SEATED)"
  performances ||--o{ orders : "bán vé"
  orders ||--|{ order_items : "mỗi dòng một vé"
  order_items }o--o| seats : "ghế (null nếu vé đứng)"
  users {
    uuid id PK
    text email UK
    text password_hash
    enum role
  }
  refresh_tokens {
    uuid id PK
    uuid family_id
    text token_hash UK
    timestamptz revoked_at
  }
  performances {
    uuid id PK
    enum status
    int max_tickets_per_user
  }
  zones {
    uuid id PK
    enum type
    int price
    int capacity
    int held_count
    int sold_count
  }
  seats {
    uuid id PK
    text row_label
    int seat_number
    enum status
  }
```

### Đăng nhập và xoay vòng refresh token

Access token sống 15 phút và nằm trong bộ nhớ của trang. Refresh token sống 7 ngày, nằm trong cookie `httpOnly` nên JavaScript không đọc được. Mỗi lần dùng, refresh token cũ bị thu hồi và một token mới được cấp.

```mermaid
sequenceDiagram
  autonumber
  participant B as Trình duyệt
  participant A as API
  participant D as PostgreSQL
  B->>A: POST /auth/login (email, mật khẩu)
  A->>D: tìm user, so mật khẩu bằng argon2
  A->>D: lưu SHA-256 của refresh token R1 (family F)
  A-->>B: accessToken trong body + cookie httpOnly R1
  Note over B: 15 phút sau access token hết hạn
  B->>A: POST /auth/refresh (cookie R1)
  A->>D: UPDATE ... SET revoked_at = now() WHERE hash(R1) AND revoked_at IS NULL
  A->>D: lưu R2 (cùng family F)
  A-->>B: accessToken mới + cookie R2
```

### Phát hiện refresh token bị đánh cắp

Nếu một token đã bị thu hồi lại được gửi lên, nghĩa là có hai người cùng giữ nó. Hệ thống thu hồi cả family, và cả hai đều phải đăng nhập lại.

```mermaid
sequenceDiagram
  autonumber
  participant K as Kẻ trộm (có bản sao R1)
  participant U as Người dùng thật
  participant A as API
  U->>A: refresh bằng R1
  A-->>U: OK, cấp R2 (R1 bị thu hồi)
  K->>A: refresh bằng R1 (đã bị thu hồi)
  A->>A: phát hiện dùng lại, thu hồi cả family
  A-->>K: 401 REFRESH_TOKEN_REUSED
  U->>A: refresh bằng R2
  A-->>U: 401 REFRESH_TOKEN_REUSED (đăng nhập lại)
```

### Vòng đời một đêm diễn

Bản nháp chỉ chủ concert xem được. Công bố bằng một câu `UPDATE ... WHERE status = 'DRAFT'`: hai lần bấm cùng lúc thì chỉ một lần thành công.

```mermaid
stateDiagram-v2
  [*] --> DRAFT: POST /concerts/:id/performances
  DRAFT --> DRAFT: PATCH (sửa địa điểm, giờ, giới hạn vé)
  DRAFT --> PUBLISHED: POST /performances/:id/publish
  PUBLISHED --> PUBLISHED: PATCH
  PUBLISHED --> CANCELLED: hủy (giai đoạn 5)
  CANCELLED --> [*]
```

### Tạo đêm diễn trong một transaction

Đêm diễn, đợt mở bán, khu và hàng nghìn ghế được tạo cùng nhau: hoặc tất cả thành công, hoặc không có gì được ghi.

```mermaid
flowchart TB
  v["Kiểm tra: tên khu không trùng, đợt mở bán không chồng nhau, kết thúc trước giờ diễn, tối đa 20.000 ghế"] --> own["Kiểm tra quyền sở hữu concert"]
  own --> tx
  subgraph tx["Một transaction"]
    p["INSERT performance (DRAFT) + sale_phases"] --> z["INSERT từng zone"]
    z --> s["Sinh ghế: hàng A..Z, AA..; INSERT theo lô 5.000"]
  end
  tx -->|"thành công"| ok["201 + chi tiết đêm diễn"]
  tx -->|"lỗi bất kỳ"| rb["ROLLBACK: không để lại dữ liệu dở dang"]
```

## Con số

| Chỉ số | Giá trị |
| --- | --- |
| Unit test / e2e test | 12 / 29, đều qua |
| Seed (5.002 tài khoản, 16.100 ghế) | khoảng 4,5 giây |
| `GET /performances/:id/seats` với 8.000 ghế | 1,1 MB, 65–100 ms (tối ưu ở giai đoạn 7a) |
