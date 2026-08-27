from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main" / "cloud_mqtt.c").read_text(encoding="utf-8")
CMAKE = (ROOT / "main" / "CMakeLists.txt").read_text(encoding="utf-8")


def require(fragment: str, message: str) -> None:
    if fragment not in SOURCE:
        raise AssertionError(message)


require(
    "cloud_osc_keepalive_note_control(&s_ws_keepalive",
    "cloud controls must refresh the device-local oscilloscope keepalive state",
)
require(
    "motor_diag_build_osc_heartbeat",
    "the keepalive task must build the same CRC-protected heartbeat as local control",
)
require(
    "s_runtime.send_ws_frame(frame.data, frame.len, s_runtime.ctx)",
    "local heartbeats must use the production UART send boundary",
)
require(
    'xTaskCreate(ws_osc_keepalive_task, "cloud_osc_hb"',
    "cloud initialization must create the local heartbeat task",
)
require(
    'cJSON_AddItemToObject(root, "cloud_osc_keepalive", obj)',
    "cloud status must expose local heartbeat diagnostics",
)
require(
    "now_us >= s_ws_active_until_us",
    "the uplink gate and local keepalive must expire on the same deadline",
)

if '"cloud_osc_keepalive.c"' not in CMAKE:
    raise AssertionError("the keepalive implementation must be part of the firmware build")

print("cloud osc keepalive integration regression passed")
