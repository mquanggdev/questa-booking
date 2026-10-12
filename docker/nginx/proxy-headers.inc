# Included in every location: proxy_set_header at server level is NOT
# inherited by a location that sets any proxy_set_header of its own.
# Who the client really is, for rate limiting and VNPay's vnp_IpAddr; the API
# trusts these headers only from private-network proxies.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
