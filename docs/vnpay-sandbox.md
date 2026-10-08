# Chạy thanh toán với VNPay sandbox

Mặc định hệ thống dùng **cổng giả lập** (`PAYMENT_PROVIDER=fake`). Cổng này nói đúng giao thức VNPay, nên test, load test và trang demo không cần tài khoản nào. Tài liệu này dành cho khi muốn trả tiền thật trên **sandbox** của VNPay. Lý do thiết kế xem [ADR-0012](adr/0012-payments-ipn-and-refunds.md).

## 1. Lấy thông tin merchant sandbox

1. Đăng ký tại <https://sandbox.vnpayment.vn/devreg/>. VNPay gửi email gồm:
   - `vnp_TmnCode`: mã website, 8 ký tự.
   - `vnp_HashSecret`: chuỗi bí mật dùng để ký.
   - Tài khoản đăng nhập trang quản trị merchant sandbox.
2. Đã có mã từ một dự án cũ thì dùng lại được. VNPay **không gắn mã với Return URL**: Return URL được gửi kèm trong từng yêu cầu thanh toán (`vnp_ReturnUrl`). Thứ gắn với tài khoản là **URL IPN**, khai báo ở bước 3.

Ghi hai giá trị vào `.env` ở thư mục gốc. File này đã nằm trong `.gitignore`. **Không bao giờ** commit hai giá trị này hay dán chúng vào issue hoặc chat:

```dotenv
PAYMENT_PROVIDER=vnpay
VNPAY_TMN_CODE=<mã website>
VNPAY_HASH_SECRET=<chuỗi bí mật>
VNPAY_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_API_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
```

Khi `PAYMENT_PROVIDER=vnpay` mà thiếu mã hoặc secret, API từ chối khởi động và báo rõ biến nào còn thiếu.

## 2. Mở API ra Internet để VNPay gọi IPN

VNPay gọi IPN **từ máy chủ của họ**, nên không gọi được `localhost`. Cần một URL công khai trỏ về API. Cách nhanh nhất là dùng tunnel tạm, ví dụ Cloudflare Quick Tunnel (cài `cloudflared`, không cần tài khoản):

```bash
cloudflared tunnel --url http://localhost:3200
```

Lệnh in ra một địa chỉ dạng `https://<tên-ngẫu-nhiên>.trycloudflare.com`. Đặt địa chỉ đó vào `.env`:

```dotenv
PUBLIC_BASE_URL=https://<tên-ngẫu-nhiên>.trycloudflare.com
```

Tunnel trỏ vào **trang web** (cổng `WEB_PORT`, mặc định 3200), vì web nhận mọi request rồi chuyển phần `/api/*` sang API. `PUBLIC_BASE_URL` dùng để tạo Return URL (`/checkout/result/vnpay`, một trang của web). Mỗi lần chạy lại tunnel, địa chỉ sẽ đổi, nên phải sửa lại cả `.env` lẫn bước 3, rồi tạo lại container: `docker compose up -d api worker`.

## 3. Khai báo URL IPN trong trang quản trị sandbox

Đăng nhập trang quản trị merchant sandbox, phần cấu hình website (Terminal), và đặt URL IPN:

```text
https://<tên-ngẫu-nhiên>.trycloudflare.com/api/v1/payments/ipn/vnpay
```

Thiếu bước này thì khách vẫn trả tiền được, nhưng đơn mãi là `PENDING`. Lý do: **chỉ IPN mới đổi trạng thái đơn**, Return URL chỉ để hiển thị. Nếu không vào được trang quản trị, có thể gửi URL IPN cho bộ phận hỗ trợ của VNPay để họ cấu hình.

## 4. Chạy và thanh toán thử

```bash
docker compose up -d --build
```

1. Đăng nhập, giữ vé (`POST /api/v1/reservations`), rồi gọi `POST /api/v1/orders/<id>/pay` với body `{"provider":"vnpay"}`.
2. Mở `checkoutUrl` trong response. Trang VNPay hết hạn đúng lúc hết giờ giữ vé (`vnp_ExpireDate`).
3. Chọn ngân hàng **NCB** và nhập thẻ test VNPay công bố cho sandbox: số thẻ `9704198526191432198`, tên `NGUYEN VAN A`, ngày phát hành `07/15`, OTP `123456`.
4. VNPay gọi IPN, đơn chuyển `PAID` và vé được phát. Xem bằng `GET /api/v1/orders/<id>` và `GET /api/v1/tickets`.
5. Trình duyệt quay về trang `/checkout/result/vnpay` của web. Trang này hỏi API `GET /api/v1/payments/return/vnpay` xem kết quả nghĩa là gì, rồi chờ đơn đổi trạng thái. Bản thân nó không đổi gì.

## 5. Khi có sự cố

| Hiện tượng | Nguyên nhân thường gặp |
| --- | --- |
| VNPay mở trang lỗi `Error.html?code=71`: "Website này chưa được phê duyệt" | Mã website chưa được duyệt hoặc đã ngừng hoạt động trên sandbox (gặp khi dùng lại mã của một dự án cũ). Đăng ký mã mới ở bước 1 |
| VNPay báo "Sai chữ ký" ngay khi mở trang thanh toán | Sai `VNPAY_HASH_SECRET`, hoặc secret còn dấu cách hay dấu ngoặc thừa |
| Đã trả tiền nhưng đơn vẫn `PENDING` | Chưa khai báo URL IPN, tunnel đã đổi địa chỉ, hoặc API không chạy |
| Log API có `Rejected an IPN with a bad signature` | Có request IPN không do VNPay gửi, hoặc `.env` dùng secret của một mã website khác |
| Refund ở trạng thái `FAILED` | Sandbox từ chối yêu cầu hoàn tiền. Xem `refunds.last_error`; job nằm trong queue `payments-dead-letter` |

Hoàn tiền chỉ xảy ra khi tiền đến sau lúc đơn đã đóng, khi khách trả hai lần cho một đơn, hoặc khi đêm diễn bị hủy. Khách không yêu cầu hoàn tiền được (đặc tả, mục 1).
