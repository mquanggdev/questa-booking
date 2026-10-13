# Generates questa.json: python docker/grafana/make-dashboard.py docker/grafana/dashboards/questa.json
import json, sys

DS = {"type": "prometheus", "uid": "prometheus"}
panels = []
pid = 0

def panel(title, targets, unit, x, y, w=12, h=8, kind="timeseries", desc=""):
    global pid
    pid += 1
    p = {
        "id": pid,
        "type": kind,
        "title": title,
        "description": desc,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"unit": unit, "min": 0}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
        "targets": [{"datasource": DS, "refId": chr(65 + i), "expr": e, "legendFormat": l}
                    for i, (e, l) in enumerate(targets)],
    }
    if kind == "stat":
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                        "colorMode": "value", "graphMode": "area", "textMode": "auto"}
    panels.append(p)

def row(title, y):
    global pid
    pid += 1
    panels.append({"id": pid, "type": "row", "title": title, "collapsed": False,
                   "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})

H = "questa_http_request_duration_seconds"
row("API", 0)
panel("Request/s theo route", [(f'sum by (route) (rate({H}_count{{route!="/api/v1/metrics"}}[1m]))', "{{route}}")], "reqps", 0, 1,
      desc="Mọi bản sao API cộng lại.")
panel("Độ trễ p95 theo route", [(f'histogram_quantile(0.95, sum by (le, route) (rate({H}_bucket{{route!="/api/v1/metrics"}}[1m])))', "{{route}}")], "s", 12, 1)
panel("Giữ vé (POST /reservations) theo status", [(f'sum by (status) (rate({H}_count{{method="POST",route="/api/v1/reservations"}}[1m]))', "{{status}}")], "reqps", 0, 9,
      desc="201 giữ được, 409 hết ghế, 403 thiếu vé vào cửa hoặc mã ưu tiên, 503 quá tải.")
panel("Lỗi 5xx/s theo bản sao", [(f'sum by (instance) (rate({H}_count{{status=~"5.."}}[1m]))', "{{instance}}")], "reqps", 12, 9)

row("Sự kiện: outbox, Kafka, consumer", 17)
panel("Outbox chưa gửi", [('questa_outbox_unpublished{job="worker"}', "số sự kiện chờ"), ('questa_outbox_oldest_unpublished_age_seconds{job="worker"}', "tuổi sự kiện cũ nhất (s)")], "short", 0, 18, w=8,
      desc="Tăng mãi = relay hoặc Kafka có vấn đề.")
panel("Độ trễ consumer p95 (từ lúc xảy ra tới lúc áp dụng)", [('histogram_quantile(0.95, sum by (le, consumer) (rate(questa_consumer_lag_seconds_bucket{job="worker"}[1m])))', "{{consumer}}")], "s", 8, 18, w=8)
panel("Sự kiện/s theo consumer và kết quả", [('sum by (consumer, outcome) (rate(questa_consumer_events_total{job="worker"}[1m]))', "{{consumer}} {{outcome}}"),
      ('rate(questa_outbox_published_total{job="worker"}[1m])', "relay đã gửi")], "ops", 16, 18, w=8,
      desc="duplicate = bản trùng bị bỏ qua (I7); dead-lettered = vào DLQ.")

row("Hàng đợi và hàng chờ", 26)
panel("BullMQ: job theo queue", [('sum by (queue, state) (questa_queue_jobs{state!="active"})', "{{queue}} {{state}}")], "short", 0, 27,
      desc="delayed = vé đang giữ chờ hết hạn; failed ở payments-dead-letter = hoàn tiền cần người xem.")
panel("Người trong hàng chờ ảo", [('questa_waiting_room_people{job="worker"}', "đang chờ")], "short", 12, 27)

row("Tiến trình Node", 35)
panel("Event loop lag p99", [("questa_nodejs_eventloop_lag_p99_seconds", "{{job}} {{instance}}")], "s", 0, 36, w=8,
      desc="Cao = tiến trình bận CPU (như khi vượt sức chứa ở giai đoạn 7b).")
panel("CPU", [("rate(questa_process_cpu_seconds_total[1m])", "{{job}} {{instance}}")], "percentunit", 8, 36, w=8)
panel("Bộ nhớ (RSS)", [("questa_process_resident_memory_bytes", "{{job}} {{instance}}")], "bytes", 16, 36, w=8)

dashboard = {
    "uid": "questa-overview",
    "title": "Questa Booking",
    "tags": ["questa"],
    "timezone": "browser",
    "schemaVersion": 41,
    "version": 1,
    "refresh": "5s",
    "time": {"from": "now-12m", "to": "now"},
    "panels": panels,
    "templating": {"list": []},
    "annotations": {"list": []},
}
open(sys.argv[1], "w", encoding="utf8", newline="\n").write(json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n")
print(len(panels), "panels")
