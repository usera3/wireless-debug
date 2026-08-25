from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UPLINK_HEADER = (ROOT / "main" / "cloud_ws_uplink.h").read_text(encoding="utf-8")
UPLINK_SOURCE = (ROOT / "main" / "cloud_ws_uplink.c").read_text(encoding="utf-8")
MQTT_SOURCE = (ROOT / "main" / "cloud_mqtt.c").read_text(encoding="utf-8")
WS_HEADER = (
    ROOT
    / "managed_components"
    / "espressif__esp_websocket_client"
    / "include"
    / "esp_websocket_client.h"
).read_text(encoding="utf-8")
WS_SOURCE = (
    ROOT
    / "managed_components"
    / "espressif__esp_websocket_client"
    / "esp_websocket_client.c"
).read_text(encoding="utf-8")


def require(source: str, fragment: str, message: str) -> None:
    if fragment not in source:
        raise AssertionError(message)


for field in (
    "queue_dequeue_age_samples",
    "queue_dequeue_age_total_us",
    "queue_dequeue_age_max_us",
    "queue_batch_ready_age_max_us",
    "queue_send_start_age_max_us",
    "queue_drop_age_max_us",
    "batch_wait_max_us",
    "ws_data_lock_wait_max_us",
    "ws_data_lock_timeouts",
    "ws_transport_send_max_us",
    "ws_ping_lock_wait_max_us",
    "ws_ping_lock_timeouts",
    "ws_ping_send_max_us",
):
    require(UPLINK_HEADER, field, f"missing uplink timing field: {field}")
    require(MQTT_SOURCE, f'"{field}"', f"cloud status does not publish: {field}")

require(
    UPLINK_SOURCE,
    "int64_t enqueued_us;",
    "each queued frame must retain its enqueue timestamp",
)
require(
    UPLINK_SOURCE,
    "stats_note_queue_dequeue_age",
    "sender dequeue must record the frame's queue age",
)
require(
    UPLINK_SOURCE,
    "stats_note_queue_stage_age(&s_stats.queue_send_start_age_max_us",
    "the final pre-send boundary must record oldest-frame age",
)
require(
    WS_HEADER,
    "esp_websocket_client_tx_diagnostics_t",
    "the WebSocket component must expose per-client TX stage diagnostics",
)
require(
    WS_HEADER,
    "esp_websocket_client_get_tx_diagnostics",
    "the WebSocket component must expose a read-only diagnostics getter",
)
require(
    WS_SOURCE,
    "tx_diag_note_max(&client->tx_diagnostics.data_lock_wait_max_us",
    "binary sends must time TX-lock acquisition",
)
require(
    WS_SOURCE,
    "tx_diag_note_max(&client->tx_diagnostics.transport_send_max_us",
    "binary sends must time transport writes",
)
require(
    WS_SOURCE,
    "tx_diag_note_max(&client->tx_diagnostics.ping_lock_wait_max_us",
    "automatic PING must time TX-lock acquisition",
)
require(
    WS_SOURCE,
    "tx_diag_note_max(&client->tx_diagnostics.ping_send_max_us",
    "automatic PING must time its transport write",
)

print("cloud websocket stage timing regression passed")
