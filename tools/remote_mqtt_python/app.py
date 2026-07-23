import json
import os
import hashlib
import hmac
import threading
import time
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from html import escape
from pathlib import Path
from urllib.parse import quote, unquote, urlparse
from uuid import UUID, uuid4

from flask import Flask, Response, jsonify, redirect, request, send_from_directory, session, url_for
import paho.mqtt.client as mqtt
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import ServerConnection, serve
from ws_fanout import BrowserSendPump, DeviceDownlinkRouter


BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent.parent
ORIG_WEB_DIR = Path(os.environ.get('ORIG_WEB_DIR') or (REPO_ROOT / 'dist' / 'orig'))
REMOTE_EXCEL_DIR = Path(os.environ.get('REMOTE_EXCEL_DIR') or (BASE_DIR / 'data' / 'excel'))
DATABASE_URL = os.environ.get(
    'DATABASE_URL',
    'postgresql://wireless_debug:wireless_debug@127.0.0.1:5432/wireless_debug',
)
MQTT_URL = os.environ.get('MQTT_URL', 'mqtt://127.0.0.1:1883')
MQTT_NAMESPACE = os.environ.get('MQTT_NAMESPACE', 'wireless-debug').strip('/') or 'wireless-debug'
ONLINE_SECONDS = int(os.environ.get('ONLINE_SECONDS', '60'))
CLOUD_HTTP_USER = os.environ.get('CLOUD_HTTP_USER', '')
CLOUD_HTTP_PASSWORD = os.environ.get('CLOUD_HTTP_PASSWORD', '')
CLOUD_SESSION_SECRET = os.environ.get('CLOUD_SESSION_SECRET', '')
AUTO_DISPLAY_NAME_PREFIX = 'ESP32-'
AUTO_DISPLAY_NAME_EXAMPLE = 'ESP32-001'

MQTT_TOPIC_EXAMPLES = (
    'wireless-debug/+/status',
    'wireless-debug/+/availability',
    'wireless-debug/+/ack',
    'wireless-debug/+/pub',
    'wireless-debug/+/bus-ack',
)
MQTT_INBOX_TOPIC_EXAMPLE = 'wireless-debug/{deviceId}/inbox'
ALLOWED_BUS_CHANNELS = {'notify'}
KNOWN_BUS_CHANNELS = ('notify', 'uart', 'ws', 'ble')
BUS_PAYLOAD_LIMIT = 256
REMOTE_WS_FRAME_LIMIT = 64
REMOTE_WS_FRAME_MAX_BYTES = 512
CLOUD_WS_BROWSER_QUEUE_FRAMES = int(os.environ.get('CLOUD_WS_BROWSER_QUEUE_FRAMES', '16'))
CLOUD_WS_BROWSER_CHUNK_BYTES = int(os.environ.get('CLOUD_WS_BROWSER_CHUNK_BYTES', '4096'))
CLOUD_WS_BROWSER_SEND_INTERVAL_MS = int(os.environ.get('CLOUD_WS_BROWSER_SEND_INTERVAL_MS', '40'))
CLOUD_WS_MAX_MESSAGE_BYTES = int(os.environ.get('CLOUD_WS_MAX_MESSAGE_BYTES', '16384'))
CLOUD_WS_HOST = os.environ.get('CLOUD_WS_HOST', '0.0.0.0')
CLOUD_WS_PORT = int(os.environ.get('CLOUD_WS_PORT', '18089'))
CLOUD_WS_PUBLIC_URL = os.environ.get('CLOUD_WS_PUBLIC_URL', '').rstrip('/')
REMOTE_EXCEL_MAX_BYTES = int(os.environ.get('REMOTE_EXCEL_MAX_BYTES', str(8 * 1024 * 1024)))
REMOTE_EXCEL_EXTENSIONS = {'.xls', '.xlsx', '.xlsm', '.csv'}

app = Flask(__name__, static_folder=None)
app.secret_key = CLOUD_SESSION_SECRET or hashlib.sha256(
    f'{CLOUD_HTTP_USER}:{CLOUD_HTTP_PASSWORD}:wireless-debug-cloud'.encode('utf-8')
).hexdigest()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)
mqtt_client = None
mqtt_connected = threading.Event()
remote_ws_frames = defaultdict(lambda: deque(maxlen=REMOTE_WS_FRAME_LIMIT))
remote_ws_lock = threading.Lock()
remote_ws_seq = 0
cloud_ws_clients = defaultdict(dict)
cloud_ws_downlinks = DeviceDownlinkRouter(REMOTE_WS_FRAME_MAX_BYTES)
cloud_ws_lock = threading.RLock()
cloud_ws_started = False
cloud_ws_browser_dropped_frames_total = 0


def note_cloud_ws_browser_drop(count):
    global cloud_ws_browser_dropped_frames_total
    with cloud_ws_lock:
        cloud_ws_browser_dropped_frames_total += max(0, int(count))


def db_connect():
    return psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)


def init_db():
    schema_sql = (BASE_DIR / 'schema.sql').read_text(encoding='utf-8')
    with db_connect() as conn:
        conn.execute(schema_sql)
        backfill_missing_display_names(conn)


def normalize_display_name(value):
    if value is None:
        return None
    name = str(value).strip()
    return name[:128] if name else None


def next_auto_display_name(conn):
    rows = conn.execute(
        "select display_name from cloud_devices where display_name is not null"
    ).fetchall()
    used = set()
    for row in rows:
        name = str(row.get('display_name') or '').strip()
        if not name.startswith(AUTO_DISPLAY_NAME_PREFIX):
            continue
        suffix = name[len(AUTO_DISPLAY_NAME_PREFIX):]
        if suffix.isdigit():
            used.add(int(suffix))

    index = 1
    while index in used:
        index += 1
    return f'{AUTO_DISPLAY_NAME_PREFIX}{index:03d}'


def ensure_device_display_name(conn, device_id):
    row = conn.execute(
        "select display_name from cloud_devices where device_id = %s",
        (device_id,),
    ).fetchone()
    if not row:
        return None
    current = normalize_display_name(row.get('display_name'))
    if current:
        return current

    display_name = next_auto_display_name(conn)
    conn.execute(
        """
        update cloud_devices
        set display_name = %s, updated_at = now()
        where device_id = %s and (display_name is null or btrim(display_name) = '')
        """,
        (display_name, device_id),
    )
    return display_name


def backfill_missing_display_names(conn):
    rows = conn.execute(
        """
        select device_id
        from cloud_devices
        where display_name is null or btrim(display_name) = ''
        order by created_at asc, device_id asc
        """
    ).fetchall()
    for row in rows:
        ensure_device_display_name(conn, row['device_id'])


def to_jsonable(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    return value


def json_response(payload, status=200):
    return jsonify(to_jsonable(payload)), status


def bool_value(value):
    return value is True or value in (1, '1', 'true', 'True', 'yes', 'on')


def int_value(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_device_dir_name(device_id):
    value = str(device_id or '').strip()
    safe = ''.join(ch if ch.isalnum() or ch in ('-', '_', '.') else '_' for ch in value)
    safe = safe[:128].strip('._')
    return safe or 'unknown'


def normalize_excel_filename(value):
    raw = unquote(str(value or '')).strip().replace('\\', '/')
    if not raw or '\x00' in raw:
        return None
    name = Path(raw).name.strip()
    if not name or name in ('.', '..') or '/' in name or '\\' in name:
        return None
    if len(name.encode('utf-8')) > 180:
        return None
    if Path(name).suffix.lower() not in REMOTE_EXCEL_EXTENSIONS:
        return None
    return name


def remote_excel_dir(device_id, create=True):
    path = REMOTE_EXCEL_DIR / safe_device_dir_name(device_id)
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def nested_dict(value):
    return value if isinstance(value, dict) else {}


def nested_number(payload, *path):
    value = payload
    for key in path:
        value = nested_dict(value).get(key)
    return int_value(value)


def extract_cloud_metrics(payload):
    payload = nested_dict(payload)
    heap = nested_dict(payload.get('heap'))
    display = nested_dict(payload.get('display'))
    menu = nested_dict(payload.get('menu'))
    motor_params = nested_dict(payload.get('motor_params'))
    comm = nested_dict(payload.get('comm_stats'))

    comm_error_total = sum(value or 0 for value in [
        nested_number(comm, 'uart', 'tx_failures'),
        nested_number(comm, 'uart', 'overflows'),
        nested_number(comm, 'ble', 'notify_failures'),
        nested_number(comm, 'ble', 'no_subscriber_drops'),
        nested_number(comm, 'ble', 'alloc_failures'),
        nested_number(comm, 'wifi', 'tx_failures'),
        nested_number(comm, 'wifi', 'no_client_drops'),
        nested_number(comm, 'wifi', 'pool_exhausted'),
        nested_number(comm, 'wifi', 'queue_full'),
        nested_number(comm, 'wifi', 'httpd_queue_failures'),
        nested_number(comm, 'wifi', 'rx_failures'),
        nested_number(comm, 'route', 'idle_drops'),
        nested_number(comm, 'route', 'unavailable_drops'),
        nested_number(comm, 'route', 'partial_drops'),
    ])

    return {
        'device_mac': payload.get('device_mac'),
        'heap_free': int_value(heap.get('free')),
        'heap_min_free': int_value(heap.get('min_free')),
        'heap_largest': int_value(heap.get('largest')),
        'heap_internal_free': int_value(heap.get('internal_free')),
        'heap_internal_min_free': int_value(heap.get('internal_min_free')),
        'restart_reason': int_value(payload.get('restart_reason')),
        'comm_error_total': comm_error_total,
        'display_status': display.get('status'),
        'display_backend': display.get('backend'),
        'display_enabled': bool_value(display.get('enabled')),
        'menu_active': bool_value(menu.get('active')),
        'menu_title': menu.get('title'),
        'menu_message': menu.get('message'),
        'motor_param_count': int_value(motor_params.get('count')),
        'motor_param_capacity': int_value(motor_params.get('capacity')),
    }


def bool_from_device(device, key):
    if key in device and device.get(key) is not None:
        return bool_value(device.get(key))
    payload = device.get('last_status_json') or {}
    return bool_value(payload.get(key))


def status_age_seconds(last_seen_at):
    if not last_seen_at:
        return None
    if last_seen_at.tzinfo is None:
        last_seen_at = last_seen_at.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - last_seen_at).total_seconds()))


def diagnose_device_state(device):
    payload = device.get('last_status_json') or {}
    metrics = extract_cloud_metrics(payload)
    cloud_state = device.get('cloud_state') or 'unknown'
    net_mode = str(device.get('net_mode') or payload.get('net_mode') or '').lower()
    age_seconds = status_age_seconds(device.get('last_seen_at'))

    if cloud_state == 'unknown':
        return {
            'health_score': 0,
            'diagnostic_level': 'unknown',
            'diagnostic_text': '尚未收到状态上报',
            'diagnostic_reasons': ['尚未收到设备状态上报'],
            'status_age_seconds': age_seconds,
        }
    if cloud_state == 'offline':
        return {
            'health_score': 20,
            'diagnostic_level': 'offline',
            'diagnostic_text': '设备离线',
            'diagnostic_reasons': ['超过心跳窗口未收到设备状态'],
            'status_age_seconds': age_seconds,
        }

    score = 100
    reasons = []
    sta_connected = bool_from_device(device, 'sta_connected')
    sta_configured = bool_from_device(device, 'sta_configured')
    sta_connecting = bool_from_device(device, 'sta_connecting')
    ble_ready = bool_from_device(device, 'ble_ready')
    ble_subscribed = bool_from_device(device, 'ble_subscribed')
    wifi_ws_client = bool_from_device(device, 'wifi_ws_client')

    if age_seconds is not None and age_seconds > 20:
        score -= 15
        reasons.append(f'最近状态上报已过去 {age_seconds} 秒')
    if net_mode in ('sta', 'apsta') and not sta_connected:
        score -= 35
        reasons.append('STA 当前未连接')
    if net_mode in ('sta', 'apsta') and not sta_configured:
        score -= 10
        reasons.append('STA 尚未保存配置')
    if sta_connecting:
        score -= 8
        reasons.append('STA 正在连接中')
    if not ble_ready:
        score -= 10
        reasons.append('BLE 未启动')
    elif not ble_subscribed:
        score -= 3
        reasons.append('BLE 暂无订阅者')
    if not wifi_ws_client:
        score -= 5
        reasons.append('局域网 WebSocket 暂无客户端')
    if metrics['heap_internal_free'] is not None and metrics['heap_internal_free'] < 32000:
        score -= 12
        reasons.append('内部堆内存偏低')
    if metrics['heap_free'] is not None and metrics['heap_free'] < 120000:
        score -= 8
        reasons.append('总可用堆内存偏低')
    if metrics['comm_error_total'] > 0:
        score -= min(20, 5 + metrics['comm_error_total'])
        reasons.append(f'通信错误/丢弃累计 {metrics["comm_error_total"]} 次')
    if metrics['restart_reason'] is not None and metrics['restart_reason'] not in (1,):
        score -= 5
        reasons.append(f'重启原因码 {metrics["restart_reason"]}')

    score = max(0, min(100, score))
    if score >= 85:
        level = 'normal'
        text = '状态正常'
    elif score >= 60:
        level = 'attention'
        text = '需要关注'
    else:
        level = 'warning'
        text = '需要检查'

    if not reasons:
        reasons.append('心跳、STA、BLE 与云端 MQTT 状态正常')
    return {
        'health_score': score,
        'diagnostic_level': level,
        'diagnostic_text': text,
        'diagnostic_reasons': reasons,
        'status_age_seconds': age_seconds,
        **metrics,
    }


def text_payload(payload):
    if isinstance(payload, bytes):
        return payload.decode('utf-8', errors='replace')
    return str(payload or '')


def parse_topic(topic):
    parts = str(topic or '').split('/')
    if len(parts) != 3 or parts[0] != MQTT_NAMESPACE:
        return None, None
    return parts[1], parts[2]


def record_event(conn, device_id, event_type, payload):
    conn.execute(
        """
        insert into cloud_device_status_events (id, device_id, event_type, payload_json, created_at)
        values (%s, %s, %s, %s, now())
        """,
        (uuid4(), device_id, event_type, Jsonb(payload)),
    )


def record_status(device_id, payload):
    raw = text_payload(payload)
    try:
        status = json.loads(raw)
    except json.JSONDecodeError as exc:
        status = {'raw': raw, 'parse_error': str(exc)}

    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (
              device_id, device_mac, availability, net_mode, ap_ip, sta_ip, sta_connected,
              uart_baud, fw_version, last_seen_at, last_status_json, updated_at
            )
            values (%s, %s, 'online', %s, %s, %s, %s, %s, %s, now(), %s, now())
            on conflict (device_id) do update set
              device_mac = coalesce(excluded.device_mac, cloud_devices.device_mac),
              availability = 'online',
              net_mode = excluded.net_mode,
              ap_ip = excluded.ap_ip,
              sta_ip = excluded.sta_ip,
              sta_connected = excluded.sta_connected,
              uart_baud = excluded.uart_baud,
              fw_version = excluded.fw_version,
              last_seen_at = excluded.last_seen_at,
              last_status_json = excluded.last_status_json,
              updated_at = excluded.updated_at
            """,
            (
                device_id,
                status.get('device_mac'),
                status.get('net_mode'),
                status.get('ap_ip'),
                status.get('sta_ip'),
                bool_value(status.get('sta_connected')),
                int_value(status.get('uart_baud')),
                status.get('fw') or status.get('fw_version') or status.get('version'),
                Jsonb(status),
            ),
        )
        ensure_device_display_name(conn, device_id)
        record_event(conn, device_id, 'status', status)


def record_availability(device_id, payload):
    availability = 'online' if text_payload(payload).strip() == 'online' else 'offline'
    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, last_seen_at, updated_at)
            values (%s, %s, case when %s = 'online' then now() else null end, now())
            on conflict (device_id) do update set
              availability = excluded.availability,
              last_seen_at = coalesce(excluded.last_seen_at, cloud_devices.last_seen_at),
              updated_at = excluded.updated_at
            """,
            (device_id, availability, availability),
        )
        ensure_device_display_name(conn, device_id)
        record_event(conn, device_id, 'availability', {'availability': availability})


def record_ack(device_id, payload):
    raw = text_payload(payload)
    try:
        ack = json.loads(raw)
    except json.JSONDecodeError as exc:
        ack = {'ok': False, 'message': f'ack parse error: {exc}', 'raw': raw}

    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, last_seen_at, updated_at)
            values (%s, 'online', now(), now())
            on conflict (device_id) do update set
              availability = 'online',
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at
            """,
            (device_id,),
        )
        ensure_device_display_name(conn, device_id)
        if ack.get('command_id'):
            conn.execute(
                """
                update cloud_device_commands
                set state = %s, ack_ok = %s, ack_message = %s, ack_at = now()
                where command_id = %s
                """,
                (
                    'ACKED' if ack.get('ok') is True else 'FAILED',
                    ack.get('ok') is True,
                    ack.get('message'),
                    ack.get('command_id'),
                ),
            )
        record_event(conn, device_id, 'ack', ack)


def requested_by_value():
    return str(
        request.headers.get('X-User')
        or request.headers.get('X-Forwarded-User')
        or request.remote_addr
        or 'cloud'
    )[:128]


def normalize_bus_channel(value):
    channel = str(value or 'notify').strip().lower()
    return channel if channel in KNOWN_BUS_CHANNELS else ''


def normalize_payload_text(value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    text = str(value or '').strip()
    return text[:BUS_PAYLOAD_LIMIT]


def bus_message_payload(message_id, source_type, source_id, target_type, target_id, channel,
                        payload_type, payload_text):
    return {
        'message_id': message_id,
        'source_type': source_type,
        'source_id': source_id,
        'target_type': target_type,
        'target_id': target_id,
        'channel': channel,
        'payload_type': payload_type,
        'payload_text': payload_text,
        'payload': payload_text,
        'ttl': 1,
    }


def publish_bus_message(conn, message_id, target_device_id, payload):
    if not mqtt_connected.is_set() or mqtt_client is None:
        conn.execute(
            """
            update cloud_bus_messages
            set state = 'FAILED', ack_ok = false, ack_message = 'mqtt broker disconnected'
            where message_id = %s
            """,
            (message_id,),
        )
        return False, 'mqtt broker disconnected'

    info = mqtt_client.publish(
        f'{MQTT_NAMESPACE}/{target_device_id}/inbox',
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
        qos=1,
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        message = f'mqtt publish failed: {info.rc}'
        conn.execute(
            """
            update cloud_bus_messages
            set state = 'FAILED', ack_ok = false, ack_message = %s
            where message_id = %s
            """,
            (message, message_id),
        )
        return False, message

    conn.execute(
        """
        update cloud_bus_messages
        set state = 'PUBLISHED', published_at = now()
        where message_id = %s
        """,
        (message_id,),
    )
    return True, 'published'


def create_bus_message(conn, source_type, source_id, target_type, target_id, channel,
                       payload_text, requested_by, message_id=None, payload_type='text',
                       payload_json=None, initial_state='PENDING'):
    message_id = message_id or f'bus-{int(time.time() * 1000)}-{uuid4().hex[:8]}'
    payload_json = payload_json if isinstance(payload_json, dict) else {}
    conn.execute(
        """
        insert into cloud_bus_messages (
          id, message_id, source_type, source_id, target_type, target_id, channel,
          payload_type, payload_text, payload_json, state, requested_by, created_at
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        """,
        (
            uuid4(),
            message_id,
            source_type,
            source_id,
            target_type,
            target_id,
            channel,
            payload_type,
            payload_text,
            Jsonb(payload_json),
            initial_state,
            requested_by,
        ),
    )
    return message_id


def record_bus_ack(device_id, payload):
    raw = text_payload(payload)
    try:
        ack = json.loads(raw)
    except json.JSONDecodeError as exc:
        ack = {'ok': False, 'message': f'bus ack parse error: {exc}', 'raw': raw}

    message_id = str(ack.get('message_id') or '')
    ok = ack.get('ok') is True
    message = str(ack.get('message') or '')[:500]
    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, last_seen_at, updated_at)
            values (%s, 'online', now(), now())
            on conflict (device_id) do update set
              availability = 'online',
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at
            """,
            (device_id,),
        )
        ensure_device_display_name(conn, device_id)
        if message_id:
            conn.execute(
                """
                update cloud_bus_messages
                set state = %s, ack_ok = %s, ack_message = %s, ack_at = now()
                where message_id = %s and target_type = 'device' and target_id = %s
                """,
                ('ACKED' if ok else 'FAILED', ok, message, message_id, device_id),
            )
        record_event(conn, device_id, 'bus_ack', ack)


def route_device_publication(conn, source_device_id, channel, payload_text, source_payload):
    subscriptions = conn.execute(
        """
        select subscriber_type, subscriber_id, route_json
        from cloud_message_subscriptions
        where enabled = true
          and source_type = 'device'
          and source_id = %s
          and channel = %s
        order by created_at asc
        """,
        (source_device_id, channel),
    ).fetchall()

    routed = 0
    for subscription in subscriptions:
        subscriber_type = subscription['subscriber_type']
        subscriber_id = subscription['subscriber_id']
        message_id = f'bus-{int(time.time() * 1000)}-{uuid4().hex[:8]}'
        if subscriber_type == 'cloud':
            create_bus_message(
                conn,
                'device',
                source_device_id,
                'cloud',
                'cloud',
                channel,
                payload_text,
                'subscription',
                message_id=message_id,
                payload_json=source_payload,
                initial_state='ACKED',
            )
            conn.execute(
                """
                update cloud_bus_messages
                set ack_ok = true, ack_message = 'received by cloud', ack_at = now(), published_at = now()
                where message_id = %s
                """,
                (message_id,),
            )
            routed += 1
        elif subscriber_type == 'device':
            create_bus_message(
                conn,
                'device',
                source_device_id,
                'device',
                subscriber_id,
                channel,
                payload_text,
                'subscription',
                message_id=message_id,
                payload_json=source_payload,
            )
            bus_payload = bus_message_payload(
                message_id,
                'device',
                source_device_id,
                'device',
                subscriber_id,
                channel,
                'text',
                payload_text,
            )
            publish_bus_message(conn, message_id, subscriber_id, bus_payload)
            routed += 1
    return routed


def enqueue_remote_ws_frame(device_id, payload_hex):
    global remote_ws_seq
    if not payload_hex:
        return None
    with remote_ws_lock:
        remote_ws_seq += 1
        frame = {
            'seq': remote_ws_seq,
            'payload_hex': payload_hex,
            'created_at': datetime.utcnow(),
        }
        remote_ws_frames[device_id].append(frame)
    broadcast_remote_ws_frame(device_id, payload_hex)
    return frame


def cloud_ws_uplink_connected(device_id):
    return cloud_ws_downlinks.connected(device_id)


def send_cloud_ws_downlink(device_id, data):
    return cloud_ws_downlinks.send(device_id, data)


def publish_remote_ws_frame(device_id, data):
    if not mqtt_connected.is_set() or mqtt_client is None:
        return False, 'mqtt broker disconnected', None
    if not data:
        return False, 'empty ws frame', None
    if len(data) > REMOTE_WS_FRAME_MAX_BYTES:
        return False, 'ws frame too large', None

    message_id = f'ws-{int(time.time() * 1000)}-{uuid4().hex[:8]}'
    payload = {
        'message_id': message_id,
        'source_type': 'cloud',
        'source_id': 'remote-console',
        'target_type': 'device',
        'target_id': device_id,
        'channel': 'ws',
        'payload_hex': data.hex(),
        'ttl': 1,
    }
    info = mqtt_client.publish(
        f'{MQTT_NAMESPACE}/{device_id}/inbox',
        json.dumps(payload, separators=(',', ':')),
        qos=1,
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        return False, f'mqtt publish failed: {info.rc}', message_id
    return True, 'published', message_id


def broadcast_remote_ws_frame(device_id, payload_hex):
    try:
        payload = bytes.fromhex(str(payload_hex or ''))
    except ValueError:
        app.logger.warning('invalid remote ws payload hex for %s', device_id)
        return
    if not payload:
        return

    broadcast_remote_ws_bytes(device_id, payload)


def broadcast_remote_ws_bytes(device_id, payload):
    data = bytes(payload or b'')
    if not data:
        return

    with cloud_ws_lock:
        clients = list((cloud_ws_clients.get(device_id) or {}).values())

    stale = []
    for sender in clients:
        if not sender.enqueue(data):
            stale.append(sender.connection)

    if stale:
        with cloud_ws_lock:
            for client in stale:
                sender = cloud_ws_clients[device_id].pop(client, None)
                if sender is not None:
                    sender.close()


def record_device_bus_publish(device_id, payload):
    raw = text_payload(payload)
    try:
        publication = json.loads(raw)
    except json.JSONDecodeError as exc:
        publication = {'channel': 'notify', 'payload_text': raw, 'parse_error': str(exc)}

    if str(publication.get('channel') or '').strip().lower() == 'ws' and publication.get('payload_hex'):
        # Waveform data is high-rate and must stay off the synchronous database path.
        # Periodic status/availability messages already maintain device presence.
        enqueue_remote_ws_frame(device_id, str(publication.get('payload_hex') or ''))
        return

    channel = normalize_bus_channel(publication.get('channel'))
    payload_text = normalize_payload_text(
        publication.get('payload_text')
        if publication.get('payload_text') is not None
        else publication.get('payload')
    )
    if not channel:
        channel = 'notify'

    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, last_seen_at, updated_at)
            values (%s, 'online', now(), now())
            on conflict (device_id) do update set
              availability = 'online',
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at
            """,
            (device_id,),
        )
        ensure_device_display_name(conn, device_id)
        source_message_id = str(publication.get('message_id') or f'pub-{int(time.time() * 1000)}-{uuid4().hex[:8]}')[:96]
        create_bus_message(
            conn,
            'device',
            device_id,
            'cloud',
            'cloud',
            channel,
            payload_text,
            'device',
            message_id=source_message_id,
            payload_json=publication if isinstance(publication, dict) else {},
            initial_state='ACKED',
        )
        conn.execute(
            """
            update cloud_bus_messages
            set ack_ok = true, ack_message = 'accepted by cloud', ack_at = now(), published_at = now()
            where message_id = %s
            """,
            (source_message_id,),
        )
        routed = route_device_publication(conn, device_id, channel, payload_text, publication)
        record_event(conn, device_id, 'bus_pub', {'publication': publication, 'routed': routed})


def publish_cloud_command(device_id, command_type, args, requested_by='cloud'):
    if not mqtt_connected.is_set() or mqtt_client is None:
        return None, 'mqtt broker disconnected'

    command_id = f'cmd-{int(time.time() * 1000)}-{uuid4().hex[:8]}'
    command = {'command_id': command_id, 'type': command_type, 'args': args or {}}
    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, updated_at)
            values (%s, 'unknown', now())
            on conflict (device_id) do nothing
            """,
            (device_id,),
        )
        ensure_device_display_name(conn, device_id)
        conn.execute(
            """
            insert into cloud_device_commands (
              id, command_id, device_id, command_type, args_json, state, requested_by, created_at
            )
            values (%s, %s, %s, %s, %s, 'PENDING', %s, now())
            """,
            (uuid4(), command_id, device_id, command_type, Jsonb(args or {}), requested_by),
        )

    info = mqtt_client.publish(
        f'{MQTT_NAMESPACE}/{device_id}/cmd',
        json.dumps(command, ensure_ascii=False, separators=(',', ':')),
        qos=1,
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        return None, f'mqtt publish failed: {info.rc}'
    return command, 'published'


def handle_mqtt_message(topic, payload):
    device_id, kind = parse_topic(topic)
    if not device_id:
        return
    try:
        if kind == 'status':
            record_status(device_id, payload)
        elif kind == 'availability':
            record_availability(device_id, payload)
        elif kind == 'ack':
            record_ack(device_id, payload)
        elif kind == 'bus-ack':
            record_bus_ack(device_id, payload)
        elif kind == 'pub':
            record_device_bus_publish(device_id, payload)
    except Exception as exc:
        app.logger.exception('failed to handle MQTT message %s: %s', topic, exc)


def make_mqtt_client():
    client_id = f'wireless-debug-python-cloud-{os.getpid()}-{int(time.time())}'
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    except AttributeError:
        client = mqtt.Client(client_id=client_id)

    parsed = urlparse(MQTT_URL)
    if parsed.username:
        client.username_pw_set(parsed.username, parsed.password)

    def on_connect(client, userdata, flags, reason_code, properties=None):
        code = int(getattr(reason_code, 'value', reason_code))
        if code == 0:
            mqtt_connected.set()
            for suffix in ('status', 'availability', 'ack', 'pub', 'bus-ack'):
                client.subscribe(f'{MQTT_NAMESPACE}/+/{suffix}', qos=1)
            app.logger.info('mqtt connected to %s', MQTT_URL)
        else:
            mqtt_connected.clear()
            app.logger.warning('mqtt connect failed: %s', reason_code)

    def on_disconnect(client, userdata, flags, reason_code=None, properties=None):
        mqtt_connected.clear()
        app.logger.warning('mqtt disconnected: %s', reason_code)

    def on_message(client, userdata, message):
        handle_mqtt_message(message.topic, message.payload)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    host = parsed.hostname or '127.0.0.1'
    port = parsed.port or 1883
    client.connect_async(host, port, keepalive=60)
    return client


def start_mqtt():
    global mqtt_client
    if mqtt_client is not None:
        return
    mqtt_client = make_mqtt_client()
    mqtt_client.loop_start()


def cloud_ws_device_id(path):
    parsed = urlparse(path or '')
    prefix = '/ws/device/'
    if not parsed.path.startswith(prefix):
        return None
    device_id = unquote(parsed.path[len(prefix):]).strip()
    return device_id or None


def cloud_ws_uplink_device_id(path):
    parsed = urlparse(path or '')
    prefix = '/ws/uplink/'
    if not parsed.path.startswith(prefix):
        return None
    device_id = unquote(parsed.path[len(prefix):]).strip()
    return device_id or None


def cloud_ws_browser_handler(connection: ServerConnection, device_id):
    sender = BrowserSendPump(
        connection,
        max_frames=CLOUD_WS_BROWSER_QUEUE_FRAMES,
        on_error=lambda exc: app.logger.warning(
            'cloud websocket browser send failed for %s: %s', device_id, exc),
        on_drop=note_cloud_ws_browser_drop,
        chunk_bytes=CLOUD_WS_BROWSER_CHUNK_BYTES,
        min_send_interval=CLOUD_WS_BROWSER_SEND_INTERVAL_MS / 1000,
    )
    with cloud_ws_lock:
        cloud_ws_clients[device_id][connection] = sender
    sender.start()
    app.logger.info('cloud websocket browser connected: %s', device_id)

    try:
        while True:
            message = connection.recv()
            if isinstance(message, str):
                data = message.encode('utf-8')
            else:
                data = bytes(message or b'')
            ok, msg = send_cloud_ws_downlink(device_id, data)
            if not ok:
                app.logger.warning('cloud websocket downlink dropped for %s: %s', device_id, msg)
    except ConnectionClosed as exc:
        app.logger.info(
            'cloud websocket browser closed for %s: code=%s reason=%s',
            device_id,
            exc.code,
            exc.reason,
        )
    except Exception as exc:
        app.logger.warning('cloud websocket closed for %s: %s', device_id, exc)
    finally:
        with cloud_ws_lock:
            cloud_ws_clients[device_id].pop(connection, None)
        sender.close()
        app.logger.info('cloud websocket browser disconnected: %s', device_id)


def cloud_ws_uplink_handler(connection: ServerConnection, device_id):
    previous = cloud_ws_downlinks.attach(device_id, connection)
    if previous is not None and previous is not connection:
        try:
            previous.close(code=1000, reason='uplink replaced')
        except Exception:
            pass
    app.logger.info('cloud websocket uplink connected: %s', device_id)

    try:
        while True:
            message = connection.recv()
            if isinstance(message, str):
                app.logger.warning('ignoring text websocket uplink frame for %s', device_id)
                continue
            data = bytes(message or b'')
            if data:
                broadcast_remote_ws_bytes(device_id, data)
    except ConnectionClosed as exc:
        app.logger.warning(
            'cloud websocket uplink closed for %s: code=%s reason=%s',
            device_id,
            exc.code,
            exc.reason,
        )
    except Exception as exc:
        app.logger.warning('cloud websocket uplink closed for %s: %s', device_id, exc)
    finally:
        cloud_ws_downlinks.detach(device_id, connection)
        app.logger.info('cloud websocket uplink disconnected: %s', device_id)


def cloud_ws_handler(connection: ServerConnection):
    path = connection.request.path
    uplink_device_id = cloud_ws_uplink_device_id(path)
    if uplink_device_id:
        cloud_ws_uplink_handler(connection, uplink_device_id)
        return

    device_id = cloud_ws_device_id(path)
    if device_id:
        cloud_ws_browser_handler(connection, device_id)
        return

    connection.close(code=1008, reason='invalid websocket path')


def start_cloud_ws_server():
    global cloud_ws_started
    if cloud_ws_started:
        return
    cloud_ws_started = True

    def run():
        try:
            with serve(
                cloud_ws_handler,
                CLOUD_WS_HOST,
                CLOUD_WS_PORT,
                max_size=CLOUD_WS_MAX_MESSAGE_BYTES,
                # The uplink is already continuously active while sampling and device
                # availability is tracked by MQTT. Protocol pings can time out when an
                # ESP32 is busy sending waveform frames and incorrectly kill the stream.
                ping_interval=None,
            ) as server:
                app.logger.info('cloud websocket serving on %s:%s', CLOUD_WS_HOST, CLOUD_WS_PORT)
                server.serve_forever()
        except Exception as exc:
            app.logger.exception('cloud websocket server stopped: %s', exc)

    thread = threading.Thread(target=run, name='cloud_ws_server', daemon=True)
    thread.start()


def cloud_state_sql():
    return f"""
      case
        when last_seen_at is null then 'unknown'
        when last_seen_at >= now() - interval '{ONLINE_SECONDS} seconds' then 'online'
        else 'offline'
      end
    """


@app.before_request
def require_cloud_login():
    if not CLOUD_HTTP_USER or not CLOUD_HTTP_PASSWORD:
        return None

    if request.path in ('/login', '/logout', '/favicon.ico'):
        return None

    if session.get('cloud_authenticated') is True:
        return None

    auth = request.authorization
    if auth and credentials_match(auth.username, auth.password):
        return None

    if wants_json_response():
        return json_response({'ok': False, 'message': 'authentication required'}, 401)
    return redirect(url_for('login', next=current_request_path()))


def credentials_match(username, password):
    return hmac.compare_digest(str(username or ''), CLOUD_HTTP_USER) and hmac.compare_digest(
        str(password or ''),
        CLOUD_HTTP_PASSWORD,
    )


def wants_json_response():
    if request.method not in ('GET', 'HEAD'):
        return True
    if request.path.startswith('/api/') or request.path.startswith('/platform/api/'):
        return True
    if request.path.startswith('/remote/') and '/api/' in request.path:
        return True
    return 'application/json' in (request.headers.get('Accept') or '').lower()


def current_request_path():
    path = request.path or '/'
    if request.query_string:
        path = f'{path}?{request.query_string.decode("utf-8", errors="ignore")}'
    return safe_next_path(path)


def safe_next_path(value):
    candidate = str(value or '').strip()
    if not candidate:
        return '/cloud.html'
    parsed = urlparse(candidate)
    if parsed.scheme or parsed.netloc:
        return '/cloud.html'
    if not candidate.startswith('/') or candidate.startswith('//'):
        return '/cloud.html'
    if candidate.startswith('/login') or candidate.startswith('/logout'):
        return '/cloud.html'
    return candidate


def render_login_page(error='', status=200):
    next_path = safe_next_path(request.values.get('next'))
    username_value = escape(CLOUD_HTTP_USER or 'admin@admin.com', quote=True)
    error_html = ''
    if error:
        error_html = f'<div class="alert">{escape(error)}</div>'
    return Response(f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>无线调试云端观测台 - 登录</title>
  <style>
    :root {{
      color-scheme: light;
      --text: #0f172a;
      --muted: #64748b;
      --line: #dbe7f0;
      --field: #eaf1fb;
      --brand: #14b8a6;
      --brand-dark: #0f766e;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--text);
      background:
        linear-gradient(rgba(214, 245, 240, .58) 1px, transparent 1px),
        linear-gradient(90deg, rgba(214, 245, 240, .58) 1px, transparent 1px),
        radial-gradient(circle at 80% 8%, rgba(45, 212, 191, .20), transparent 28%),
        radial-gradient(circle at 12% 78%, rgba(45, 212, 191, .18), transparent 30%),
        #f8fbfd;
      background-size: 64px 64px, 64px 64px, auto, auto, auto;
    }}
    main {{
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
    }}
    .shell {{
      width: min(448px, 100%);
      text-align: center;
    }}
    .logo {{
      width: 64px;
      height: 64px;
      margin: 0 auto 18px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      color: #ecfeff;
      font-weight: 800;
      letter-spacing: 0;
      background: linear-gradient(145deg, #172554, #14b8a6);
      box-shadow: 0 16px 36px rgba(15, 118, 110, .20);
    }}
    .brand {{
      margin: 0;
      font-size: 30px;
      line-height: 1.2;
      color: #0f9f8f;
      font-weight: 800;
    }}
    .subtitle {{
      margin: 8px 0 32px;
      color: var(--muted);
      font-size: 14px;
    }}
    .card {{
      padding: 34px 32px 28px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .88);
      box-shadow: 0 22px 48px rgba(15, 23, 42, .10);
      text-align: left;
    }}
    .card h1 {{
      margin: 0;
      text-align: center;
      font-size: 24px;
      line-height: 1.25;
      font-weight: 800;
    }}
    .card p {{
      margin: 10px 0 28px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }}
    label {{
      display: block;
      margin: 0 0 10px;
      color: #334155;
      font-size: 14px;
      font-weight: 500;
    }}
    .field {{
      position: relative;
      margin-bottom: 22px;
    }}
    .field svg {{
      position: absolute;
      left: 14px;
      top: 50%;
      width: 18px;
      height: 18px;
      transform: translateY(-50%);
      color: #94a3b8;
      pointer-events: none;
    }}
    input {{
      width: 100%;
      height: 42px;
      border: 1px solid #d5e0ee;
      border-radius: 8px;
      padding: 0 14px 0 44px;
      background: var(--field);
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }}
    input:focus {{
      border-color: var(--brand);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(20, 184, 166, .16);
    }}
    .password-toggle {{
      position: absolute;
      right: 8px;
      top: 50%;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 8px;
      transform: translateY(-50%);
      background: transparent;
      color: #64748b;
      cursor: pointer;
    }}
    .password-toggle:hover {{ background: rgba(15, 23, 42, .06); color: #0f172a; }}
    .password-toggle svg {{ left: 7px; width: 18px; height: 18px; }}
    .alert {{
      margin: -8px 0 18px;
      padding: 10px 12px;
      border: 1px solid #fecaca;
      border-radius: 8px;
      background: #fff1f2;
      color: #be123c;
      font-size: 14px;
    }}
    button[type="submit"] {{
      width: 100%;
      height: 42px;
      border: 0;
      border-radius: 8px;
      background: linear-gradient(90deg, #14b8a6, #0f9f8f);
      color: white;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 12px 22px rgba(20, 184, 166, .24);
    }}
    button[type="submit"]:hover {{ filter: brightness(.98); transform: translateY(-1px); }}
    footer {{
      margin-top: 26px;
      color: #94a3b8;
      font-size: 13px;
      text-align: center;
    }}
  </style>
</head>
<body>
  <main>
    <section class="shell">
      <div class="logo">WD</div>
      <h2 class="brand">Wireless Debug</h2>
      <div class="subtitle">无线调试云端观测台</div>
      <form class="card" method="post" action="/login" autocomplete="on">
        <h1>欢迎回来</h1>
        <p>登录您的账户以继续</p>
        {error_html}
        <input id="next" type="hidden" name="next" value="{escape(next_path, quote=True)}">
        <label for="username">邮箱</label>
        <div class="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6.5h16v11H4z"/><path d="m4.5 7 7.5 6 7.5-6"/></svg>
          <input id="username" name="username" type="email" value="{username_value}" required autocomplete="username">
        </div>
        <label for="password">密码</label>
        <div class="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          <input id="password" name="password" type="password" required autocomplete="current-password">
          <button class="password-toggle" type="button" aria-label="显示或隐藏密码" onclick="const p=document.getElementById('password');p.type=p.type==='password'?'text':'password';">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <button type="submit">登录</button>
      </form>
      <footer>© 2026 Wireless Debug. All rights reserved.</footer>
    </section>
  </main>
  <script>
    document.querySelector('form').addEventListener('submit', () => {{
      const next = document.getElementById('next');
      if (window.location.hash && next.value && !next.value.includes('#')) {{
        next.value += window.location.hash;
      }}
    }});
  </script>
</body>
</html>""", status=status, mimetype='text/html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if not CLOUD_HTTP_USER or not CLOUD_HTTP_PASSWORD:
        return redirect('/cloud.html')
    if request.method in ('GET', 'HEAD'):
        if session.get('cloud_authenticated') is True:
            return redirect(safe_next_path(request.args.get('next')))
        return render_login_page()

    username = request.form.get('username')
    password = request.form.get('password')
    if not credentials_match(username, password):
        session.pop('cloud_authenticated', None)
        return render_login_page('邮箱或密码不正确', status=401)

    session.permanent = True
    session['cloud_authenticated'] = True
    session['cloud_user'] = CLOUD_HTTP_USER
    return redirect(safe_next_path(request.form.get('next') or request.args.get('next')))


@app.get('/logout')
def logout():
    session.clear()
    return redirect('/login')


@app.get('/health')
def health():
    with cloud_ws_lock:
        ws_browser_clients = sum(len(clients) for clients in cloud_ws_clients.values())
        ws_browser_dropped_frames = cloud_ws_browser_dropped_frames_total
    ws_downlink = cloud_ws_downlinks.snapshot()
    return jsonify({
        'ok': True,
        'mqtt_connected': mqtt_connected.is_set(),
        'namespace': MQTT_NAMESPACE,
        'cloud_ws_port': CLOUD_WS_PORT,
        'ws_uplink_devices': cloud_ws_downlinks.device_count(),
        'ws_browser_clients': ws_browser_clients,
        'ws_browser_dropped_frames': ws_browser_dropped_frames,
        'ws_downlink_sent_frames': ws_downlink['sent_frames'],
        'ws_downlink_sent_bytes': ws_downlink['sent_bytes'],
        'ws_downlink_dropped_frames': ws_downlink['dropped_frames'],
        'ws_downlink_send_failures': ws_downlink['send_failures'],
    })


@app.get('/')
def root():
    return redirect('/cloud')


@app.get('/cloud')
def cloud():
    return redirect('/cloud.html')


@app.get('/legacy-cloud.html')
def legacy_cloud_html():
    return send_from_directory(BASE_DIR / 'static', 'cloud.html')


def cloud_ws_public_url(device_id):
    if CLOUD_WS_PUBLIC_URL:
        base = CLOUD_WS_PUBLIC_URL
    else:
        forwarded_proto = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip()
        scheme = 'wss' if forwarded_proto == 'https' or request.scheme == 'https' else 'ws'
        forwarded_host = (request.headers.get('X-Forwarded-Host') or request.host).split(',')[0].strip()
        hostname = forwarded_host.rsplit(':', 1)[0] if ':' in forwarded_host else forwarded_host
        base = f'{scheme}://{hostname}:{CLOUD_WS_PORT}'
    return f'{base.rstrip("/")}/ws/device/{quote(device_id, safe="")}'


def inject_react_runtime(html, runtime_mode, device_id=None):
    remote_ws_url = cloud_ws_public_url(device_id) if device_id else None
    script = f"""
    <script>
      window.__WIRELESS_RUNTIME_MODE = {json.dumps(runtime_mode)};
      window.__WIRELESS_REMOTE_DEVICE_ID = {json.dumps(device_id)};
      window.__WIRELESS_REMOTE_WS_URL = {json.dumps(remote_ws_url)};
    </script>
    """
    return html.replace('</head>', f'{script}</head>')


def remote_console_rewrite_script(device_id):
    device_json = json.dumps(device_id)
    remote_ws_json = json.dumps(cloud_ws_public_url(device_id))
    return f"""
    <script>
      (() => {{
        const deviceId = {device_json};
        const remotePrefix = `/remote/${{encodeURIComponent(deviceId)}}`;
        const remoteWsUrl = {remote_ws_json};
        const rewriteHttp = (raw) => {{
          const url = new URL(raw, window.location.href);
          if (url.origin !== window.location.origin) return raw;
          if (url.pathname.startsWith('/api/')) {{
            return `${{remotePrefix}}${{url.pathname}}${{url.search}}`;
          }}
          if (url.pathname.startsWith('/excel/')) {{
            return `${{remotePrefix}}${{url.pathname}}${{url.search}}`;
          }}
          return raw;
        }};
        const rewriteNavigation = (raw) => {{
          const url = new URL(raw, window.location.href);
          if (url.origin !== window.location.origin) return raw;
          if (url.pathname === '/wifi.html') {{
            return `${{remotePrefix}}/wifi.html${{url.search}}${{url.hash}}`;
          }}
          return rewriteHttp(raw);
        }};
        const rewriteAnchors = () => {{
          for (const anchor of document.querySelectorAll('a[href]')) {{
            const href = anchor.getAttribute('href');
            const next = href ? rewriteNavigation(href) : href;
            if (next && next !== href) anchor.setAttribute('href', next);
          }}
        }};
        window.addEventListener('DOMContentLoaded', () => {{
          rewriteAnchors();
          new MutationObserver(rewriteAnchors).observe(document.body, {{ childList: true, subtree: true }});
        }});
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {{
          if (typeof input === 'string') return nativeFetch(rewriteHttp(input), init);
          if (input instanceof Request) return nativeFetch(new Request(rewriteHttp(input.url), input), init);
          return nativeFetch(input, init);
        }};
        const NativeXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function RemoteXMLHttpRequest() {{
          const xhr = new NativeXHR();
          const open = xhr.open;
          xhr.open = function(method, url, ...rest) {{
            return open.call(xhr, method, rewriteHttp(url), ...rest);
          }};
          return xhr;
        }};
        window.__WIRELESS_RUNTIME_MODE = 'cloud-device';
        window.__WIRELESS_REMOTE_DEVICE_ID = deviceId;
        window.__WIRELESS_REMOTE_WS_URL = remoteWsUrl;
      }})();
    </script>
    """


def react_load_fallback_script():
    return """
    <script>
      window.addEventListener('load', () => {
        window.setTimeout(() => {
          const root = document.getElementById('root');
          if (!root || root.childElementCount > 0) return;
          document.body.innerHTML = `
            <main style="min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;padding:24px">
              <section style="max-width:520px;text-align:center">
                <h1 style="font-size:20px;margin:0 0 12px">无线调试页面加载失败</h1>
                <p style="color:#94a3b8;margin:0 0 18px">页面资源可能仍在使用旧缓存，请刷新后重试。</p>
                <button onclick="location.reload()" style="border:0;border-radius:6px;padding:9px 16px;background:#2563eb;color:white;cursor:pointer">重新加载</button>
              </section>
            </main>`;
        }, 2500);
      });
    </script>
    """


def render_react_app(runtime_mode, device_id=None):
    html_path = ORIG_WEB_DIR / 'i.html'
    if not html_path.exists():
        return Response('react app asset missing', 404)
    html = html_path.read_text(encoding='utf-8')
    for asset_name in ('a.js', 'a.css', 'x.js'):
        version = remote_console_asset_version(asset_name)
        html = html.replace(f'./{asset_name}', f'./{asset_name}?v={version}')

    runtime_html = inject_react_runtime(html, runtime_mode, device_id)
    extra_script = react_load_fallback_script()
    if runtime_mode == 'cloud-device' and device_id:
        extra_script = f'{remote_console_rewrite_script(device_id)}{extra_script}'
    injected = runtime_html.replace('</head>', f'{extra_script}</head>')
    response = Response(injected, mimetype='text/html')
    response.headers['Cache-Control'] = 'no-store, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response


@app.get('/cloud.html')
def cloud_html():
    return render_react_app('cloud-platform')


@app.get('/a.js')
@app.get('/a.css')
@app.get('/x.js')
def react_root_asset():
    return send_from_directory(ORIG_WEB_DIR, request.path.lstrip('/'))


def render_remote_console_html(device_id):
    return render_react_app('cloud-device', device_id)


def remote_console_asset_version(filename):
    path = ORIG_WEB_DIR / filename
    if not path.is_file():
        return 'missing'
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


@app.get('/remote/<device_id>/orig/')
def remote_console_index(device_id):
    return render_remote_console_html(device_id)


@app.get('/remote/<device_id>/orig/<path:filename>')
def remote_console_asset(device_id, filename):
    if filename in ('', 'i.html'):
        return render_remote_console_html(device_id)
    return send_from_directory(ORIG_WEB_DIR, filename)


@app.get('/remote/<device_id>/wifi.html')
def remote_console_wifi_html(device_id):
    device = load_remote_device(device_id)
    if not device:
        return Response('device not found', 404)

    display_name = escape(device.get('display_name') or device_id)
    sta_ip = escape(str(device.get('sta_ip') or '--'))
    return Response(f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{display_name} - 云端配网保护</title>
  <style>
    body {{ margin: 0; background: #0f172a; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    main {{ max-width: 720px; margin: 9vh auto; padding: 0 24px; }}
    section {{ border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 24px; }}
    h1 {{ margin: 0 0 12px; font-size: 22px; }}
    p {{ line-height: 1.75; color: #cbd5e1; }}
    code {{ color: #93c5fd; }}
    a {{ color: #60a5fa; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .actions {{ display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }}
    .button {{ display: inline-flex; align-items: center; border-radius: 6px; padding: 9px 13px; background: #2563eb; color: white; }}
    .secondary {{ background: #334155; }}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>{display_name} 的云端配网保护</h1>
      <p>云端控制台不允许切换 WiFi 模式，避免设备因为远程断开 STA 网络而从云平台失联。</p>
      <p>需要重新配网时，请在设备附近连接 ESP32 热点后打开 <code>http://192.168.4.1/wifi.html</code>，或使用 OLED 菜单执行本地配网。</p>
      <p>当前云端记录的 STA 地址：<code>{sta_ip}</code></p>
      <div class="actions">
        <a class="button" href="/remote/{escape(device_id)}/orig/i.html">返回控制台</a>
        <a class="button secondary" href="/cloud.html">返回设备列表</a>
      </div>
    </section>
  </main>
</body>
</html>""", mimetype='text/html')


def load_remote_device(device_id):
    state_expr = cloud_state_sql()
    with db_connect() as conn:
        row = conn.execute(
            f"select *, {state_expr} as cloud_state from cloud_devices where device_id = %s",
            (device_id,),
        ).fetchone()
    return dict(row) if row else None


def virtual_device_status(device):
    payload = device.get('last_status_json') or {}
    return {
        'ok': True,
        'net': payload.get('net_mode') or device.get('net_mode'),
        'comm': payload.get('comm_mode') or device.get('comm_mode') or 'auto',
        'uart_baud': int_value(payload.get('uart_baud') or device.get('uart_baud')),
        'ble_ready': bool_value(payload.get('ble_ready')),
        'wifi_ws_client': bool_value(payload.get('wifi_ws_client')),
    }


def virtual_wifi_status(device):
    payload = device.get('last_status_json') or {}
    return {
        'ok': True,
        'mode': payload.get('net_mode') or device.get('net_mode'),
        'ap_ip': payload.get('ap_ip') or device.get('ap_ip'),
        'sta_ip': payload.get('sta_ip') or device.get('sta_ip'),
        'sta_configured': bool_value(payload.get('sta_configured')),
        'sta_connecting': bool_value(payload.get('sta_connecting')),
        'sta_connected': bool_value(payload.get('sta_connected') or device.get('sta_connected')),
        'sta_ssid': payload.get('sta_ssid') or '',
        'ap_ssid': payload.get('ap_ssid') or '',
    }


def virtual_ble_status(device):
    payload = device.get('last_status_json') or {}
    return {
        'ok': True,
        'started': bool_value(payload.get('ble_ready')),
        'subscribed': bool_value(payload.get('ble_subscribed')),
    }


def virtual_ws_status(device):
    payload = device.get('last_status_json') or {}
    return {'ok': True, 'connected': bool_value(payload.get('wifi_ws_client'))}


def remote_console_notify(device_id, body):
    text_value = (
        body.get('text')
        or body.get('line1')
        or body.get('message')
        or body.get('payload_text')
        or ''
    )
    payload_text = normalize_payload_text(text_value)
    if not payload_text:
        return json_response({'ok': False, 'msg': 'text required'}, 400)
    with db_connect() as conn:
        message_id = create_bus_message(
            conn,
            'cloud',
            'remote-console',
            'device',
            device_id,
            'notify',
            payload_text,
            requested_by_value(),
            payload_json={'request': body, 'source': 'remote_console'},
        )
        payload = bus_message_payload(
            message_id,
            'cloud',
            'remote-console',
            'device',
            device_id,
            'notify',
            'text',
            payload_text,
        )
        ok, message = publish_bus_message(conn, message_id, device_id, payload)
    return json_response({'ok': ok, 'msg': message, 'message_id': message_id}, 200 if ok else 503)


def remote_excel_list(device_id):
    root = remote_excel_dir(device_id)
    files = [
        path.name
        for path in sorted(root.iterdir(), key=lambda item: item.name.lower())
        if path.is_file() and normalize_excel_filename(path.name)
    ]
    return json_response(files)


def remote_excel_upload(device_id):
    filename = normalize_excel_filename(
        request.headers.get('X-Filename') or request.args.get('name')
    )
    if not filename:
        return json_response({'ok': False, 'msg': 'valid excel filename required'}, 400)

    data = request.get_data() or b''
    if not data:
        return json_response({'ok': False, 'msg': 'empty file'}, 400)
    if len(data) > REMOTE_EXCEL_MAX_BYTES:
        return json_response({'ok': False, 'msg': 'file too large'}, 413)

    target = remote_excel_dir(device_id) / filename
    target.write_bytes(data)
    return json_response({'ok': True, 'name': filename, 'size': len(data)})


def remote_excel_delete(device_id):
    filename = normalize_excel_filename(request.args.get('name'))
    if not filename:
        return json_response({'ok': False, 'msg': 'valid excel filename required'}, 400)

    target = remote_excel_dir(device_id) / filename
    if target.exists():
        target.unlink()
        return json_response({'ok': True, 'name': filename})
    return json_response({'ok': False, 'msg': 'file not found'}, 404)


@app.get('/remote/<device_id>/excel/<path:filename>')
def remote_excel_download(device_id, filename):
    device = load_remote_device(device_id)
    if not device:
        return json_response({'ok': False, 'msg': 'device not found'}, 404)
    filename = normalize_excel_filename(filename)
    if not filename:
        return json_response({'ok': False, 'msg': 'valid excel filename required'}, 400)
    return send_from_directory(remote_excel_dir(device_id), filename, as_attachment=False)


@app.post('/remote/<device_id>/ws/send')
def remote_ws_send(device_id):
    data = request.get_data() or b''
    ok, msg, message_id = publish_remote_ws_frame(device_id, data)
    if ok:
        return json_response({'ok': True, 'message_id': message_id})
    if msg == 'mqtt broker disconnected':
        return json_response({'ok': False, 'msg': msg}, 503)
    if msg == 'ws frame too large':
        return json_response({'ok': False, 'msg': msg}, 413)
    if msg == 'empty ws frame':
        return json_response({'ok': False, 'msg': msg}, 400)
    return json_response({'ok': False, 'msg': msg}, 502)


@app.get('/remote/<device_id>/ws/poll')
def remote_ws_poll(device_id):
    after = int_value(request.args.get('after')) or 0
    with remote_ws_lock:
        frames = [
            frame for frame in list(remote_ws_frames[device_id])
            if int_value(frame.get('seq')) and frame['seq'] > after
        ][:REMOTE_WS_FRAME_LIMIT]
    return json_response({'ok': True, 'frames': frames})


@app.route('/remote/<device_id>/api/<path:path>', methods=['GET', 'POST', 'DELETE', 'OPTIONS'])
def proxy_remote_device_api(device_id, path):
    if request.method == 'OPTIONS':
        return json_response({'ok': True})
    device = load_remote_device(device_id)
    if not device:
        return json_response({'ok': False, 'msg': 'device not found'}, 404)

    normalized = '/' + path.strip('/')
    body = request.get_json(silent=True) or {}
    if request.method == 'GET' and normalized == '/device/status':
        return json_response(virtual_device_status(device))
    if request.method == 'GET' and normalized == '/wifi/status':
        return json_response(virtual_wifi_status(device))
    if request.method == 'GET' and normalized == '/ble/status':
        return json_response(virtual_ble_status(device))
    if request.method == 'GET' and normalized == '/ws/status':
        return json_response(virtual_ws_status(device))
    if request.method == 'GET' and normalized == '/uart/baud':
        return json_response({'ok': True, 'baud': virtual_device_status(device).get('uart_baud')})
    if request.method == 'GET' and normalized == '/comm/mode':
        return json_response({'ok': True, 'mode': virtual_device_status(device).get('comm')})
    if request.method == 'GET' and normalized == '/system/health':
        return json_response({'ok': True, 'cloud_state': device.get('cloud_state'), 'device_id': device_id})
    if request.method == 'GET' and normalized == '/excel/list':
        return remote_excel_list(device_id)

    if request.method == 'POST' and normalized == '/display/text':
        return remote_console_notify(device_id, body)
    if request.method == 'POST' and normalized == '/wifi/mode':
        return json_response({
            'ok': False,
            'msg': '云端控制台不允许切换 WiFi 模式，避免设备脱离云端。请在设备附近通过 AP/OLED 本地配网。',
        }, 403)
    if request.method == 'POST' and normalized == '/uart/baud':
        baud = int_value(body.get('baud'))
        if baud is None:
            return json_response({'ok': False, 'msg': 'baud required'}, 400)
        command, message = publish_cloud_command(device_id, 'set_uart_baud', {'baud': baud}, requested_by_value())
        return json_response({'ok': command is not None, 'msg': message, 'baud': baud}, 200 if command else 503)
    if request.method == 'POST' and normalized == '/comm/mode':
        mode = str(body.get('mode') or '').strip().lower()
        if mode not in ('auto', 'wifi', 'ble'):
            return json_response({'ok': False, 'msg': 'mode must be auto/wifi/ble'}, 400)
        command, message = publish_cloud_command(device_id, 'set_comm_mode', {'mode': mode}, requested_by_value())
        return json_response({'ok': command is not None, 'msg': message}, 200 if command else 503)
    if request.method == 'POST' and normalized == '/ble/start':
        command, message = publish_cloud_command(device_id, 'ble_start', {}, requested_by_value())
        return json_response({'ok': command is not None, 'msg': message}, 200 if command else 503)
    if request.method == 'POST' and normalized == '/excel/upload':
        return remote_excel_upload(device_id)
    if request.method == 'DELETE' and normalized == '/excel/delete':
        return remote_excel_delete(device_id)

    return json_response({'ok': False, 'msg': f'remote console proxy not implemented: {request.method} {normalized}'}, 501)


@app.get('/platform/api/devices')
@app.get('/api/devices')
def list_devices():
    state_expr = cloud_state_sql()
    with db_connect() as conn:
        rows = conn.execute(
            f"""
            select device_id, device_mac, display_name, note, availability, net_mode, ap_ip, sta_ip,
                   sta_connected, uart_baud, fw_version, last_seen_at, updated_at,
                   last_status_json,
                   (last_status_json ->> 'sta_configured')::boolean as sta_configured,
                   (last_status_json ->> 'sta_connecting')::boolean as sta_connecting,
                   last_status_json ->> 'comm_mode' as comm_mode,
                   (last_status_json ->> 'ble_ready')::boolean as ble_ready,
                   (last_status_json ->> 'ble_subscribed')::boolean as ble_subscribed,
                   (last_status_json ->> 'wifi_ws_client')::boolean as wifi_ws_client,
                   (last_status_json ->> 'uptime_ms')::bigint as uptime_ms,
                   {state_expr} as cloud_state
            from cloud_devices
            order by
              case
                when last_seen_at >= now() - interval '{ONLINE_SECONDS} seconds' then 0
                when last_seen_at is null then 2
                else 1
              end,
              last_seen_at desc nulls last,
              device_id asc
            """
        ).fetchall()

    rows = [dict(row) for row in rows]
    for row in rows:
        row.update(diagnose_device_state(row))

    summary = {'total': len(rows), 'online': 0, 'offline': 0, 'unknown': 0}
    for row in rows:
        summary[row['cloud_state']] = summary.get(row['cloud_state'], 0) + 1
    return json_response({
        'ok': True,
        'mqtt_connected': mqtt_connected.is_set(),
        'generated_at': datetime.utcnow(),
        'summary': summary,
        'devices': rows,
    })


@app.get('/api/devices/<device_id>')
def get_device(device_id):
    state_expr = cloud_state_sql()
    with db_connect() as conn:
        device = conn.execute(
            f"select *, {state_expr} as cloud_state from cloud_devices where device_id = %s",
            (device_id,),
        ).fetchone()
        if not device:
            return json_response({'ok': False, 'message': 'device not found'}, 404)
        device = dict(device)
        device.update(diagnose_device_state(device))
        events = conn.execute(
            """
            select event_type, payload_json, created_at
            from cloud_device_status_events
            where device_id = %s
            order by created_at desc
            limit 80
            """,
            (device_id,),
        ).fetchall()
        commands = conn.execute(
            """
            select command_id, command_type, args_json, state, ack_ok, ack_message,
                   requested_by, created_at, ack_at
            from cloud_device_commands
            where device_id = %s
            order by created_at desc
            limit 50
            """,
            (device_id,),
        ).fetchall()
        notes = conn.execute(
            """
            select note, created_at
            from cloud_device_notes
            where device_id = %s
            order by created_at desc
            limit 20
            """,
            (device_id,),
        ).fetchall()
    return json_response({'ok': True, 'device': device, 'events': events, 'commands': commands, 'notes': notes})


@app.get('/api/devices/<device_id>/history')
def get_device_history(device_id):
    with db_connect() as conn:
        device = conn.execute(
            "select device_id from cloud_devices where device_id = %s",
            (device_id,),
        ).fetchone()
        if not device:
            return json_response({'ok': False, 'message': 'device not found'}, 404)

        status_rows = conn.execute(
            """
            select payload_json, created_at
            from (
              select payload_json, created_at
              from cloud_device_status_events
              where device_id = %s and event_type = 'status'
              order by created_at desc
              limit 240
            ) recent_status
            order by created_at asc
            """,
            (device_id,),
        ).fetchall()
        availability_rows = conn.execute(
            """
            select payload_json, created_at
            from cloud_device_status_events
            where device_id = %s and event_type = 'availability'
            order by created_at desc
            limit 120
            """,
            (device_id,),
        ).fetchall()
        command_rows = conn.execute(
            """
            select command_id, command_type, state, ack_ok, ack_message,
                   requested_by, created_at, ack_at,
                   case
                     when ack_at is null then null
                     else round(extract(epoch from (ack_at - created_at)) * 1000)::integer
                   end as latency_ms
            from cloud_device_commands
            where device_id = %s
            order by created_at desc
            limit 120
            """,
            (device_id,),
        ).fetchall()

    status_points = []
    for row in status_rows:
        payload = row['payload_json'] or {}
        status_points.append({
            'created_at': row['created_at'],
            'uptime_ms': int_value(payload.get('uptime_ms')),
            'net_mode': payload.get('net_mode'),
            'sta_configured': bool_value(payload.get('sta_configured')),
            'sta_connecting': bool_value(payload.get('sta_connecting')),
            'sta_connected': bool_value(payload.get('sta_connected')),
            'ap_ip': payload.get('ap_ip'),
            'sta_ip': payload.get('sta_ip'),
            'uart_baud': int_value(payload.get('uart_baud')),
            'comm_mode': payload.get('comm_mode'),
            'ble_ready': bool_value(payload.get('ble_ready')),
            'ble_subscribed': bool_value(payload.get('ble_subscribed')),
            'wifi_ws_client': bool_value(payload.get('wifi_ws_client')),
            **extract_cloud_metrics(payload),
        })

    latencies = [row['latency_ms'] for row in command_rows if row.get('latency_ms') is not None]
    summary = {
        'status_count': len(status_points),
        'availability_count': len(availability_rows),
        'command_count': len(command_rows),
        'acked_count': sum(1 for row in command_rows if row.get('state') == 'ACKED'),
        'failed_count': sum(1 for row in command_rows if row.get('state') == 'FAILED'),
        'avg_latency_ms': round(sum(latencies) / len(latencies)) if latencies else None,
    }
    return json_response({
        'ok': True,
        'device_id': device_id,
        'summary': summary,
        'status_points': status_points,
        'availability': availability_rows,
        'commands': command_rows,
    })


@app.post('/api/devices/<device_id>/query-status')
def query_status(device_id):
    if not mqtt_connected.is_set():
        return json_response({'ok': False, 'message': 'mqtt broker disconnected'}, 503)

    command_id = f'cmd-{int(time.time() * 1000)}-{uuid4().hex[:8]}'
    command = {'command_id': command_id, 'type': 'query_status', 'args': {}}
    requested_by = (
        request.headers.get('X-User')
        or request.headers.get('X-Forwarded-User')
        or request.remote_addr
        or 'internal'
    )

    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, availability, updated_at)
            values (%s, 'unknown', now())
            on conflict (device_id) do nothing
            """,
            (device_id,),
        )
        ensure_device_display_name(conn, device_id)
        conn.execute(
            """
            insert into cloud_device_commands (
              id, command_id, device_id, command_type, args_json, state, requested_by, created_at
            )
            values (%s, %s, %s, 'query_status', %s, 'PENDING', %s, now())
            """,
            (uuid4(), command_id, device_id, Jsonb({}), str(requested_by)[:128]),
        )

    info = mqtt_client.publish(
        f'{MQTT_NAMESPACE}/{device_id}/cmd',
        json.dumps(command, separators=(',', ':')),
        qos=1,
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        return json_response({'ok': False, 'message': f'mqtt publish failed: {info.rc}'}, 502)
    return json_response({'ok': True, 'command': command})


@app.post('/api/devices/<device_id>/display-name')
def save_display_name(device_id):
    body = request.get_json(silent=True) or {}
    requested_name = normalize_display_name(body.get('display_name'))

    with db_connect() as conn:
        display_name = requested_name or next_auto_display_name(conn)
        try:
            conn.execute(
                """
                insert into cloud_devices (device_id, display_name, updated_at)
                values (%s, %s, now())
                on conflict (device_id) do update set
                  display_name = excluded.display_name,
                  updated_at = excluded.updated_at
                """,
                (device_id, display_name),
            )
        except psycopg.errors.UniqueViolation:
            return json_response({'ok': False, 'message': '设备名已存在'}, 409)
    return json_response({'ok': True, 'display_name': display_name, 'updated_at': datetime.utcnow()})


@app.post('/api/devices/<device_id>/note')
def save_note(device_id):
    body = request.get_json(silent=True) or {}
    note = str(body.get('note') or '').strip()[:500]
    if not note:
        return json_response({'ok': False, 'message': 'note is required'}, 400)

    with db_connect() as conn:
        conn.execute(
            """
            insert into cloud_devices (device_id, note, updated_at)
            values (%s, %s, now())
            on conflict (device_id) do update set note = excluded.note, updated_at = excluded.updated_at
            """,
            (device_id, note),
        )
        ensure_device_display_name(conn, device_id)
        conn.execute(
            """
            insert into cloud_device_notes (id, device_id, note, created_at)
            values (%s, %s, %s, now())
            """,
            (uuid4(), device_id, note),
        )
    return json_response({'ok': True, 'note': note, 'created_at': datetime.utcnow()})


@app.get('/api/bus/messages')
def list_bus_messages():
    device_id = str(request.args.get('device_id') or '').strip()
    limit = min(max(int_value(request.args.get('limit')) or 80, 1), 200)
    with db_connect() as conn:
        if device_id:
            rows = conn.execute(
                """
                select m.*, sd.display_name as source_display_name, td.display_name as target_display_name
                from cloud_bus_messages m
                left join cloud_devices sd on m.source_type = 'device' and m.source_id = sd.device_id
                left join cloud_devices td on m.target_type = 'device' and m.target_id = td.device_id
                where (m.source_type = 'device' and m.source_id = %s)
                   or (m.target_type = 'device' and m.target_id = %s)
                order by m.created_at desc
                limit %s
                """,
                (device_id, device_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                select m.*, sd.display_name as source_display_name, td.display_name as target_display_name
                from cloud_bus_messages m
                left join cloud_devices sd on m.source_type = 'device' and m.source_id = sd.device_id
                left join cloud_devices td on m.target_type = 'device' and m.target_id = td.device_id
                order by m.created_at desc
                limit %s
                """,
                (limit,),
            ).fetchall()
    return json_response({'ok': True, 'messages': rows, 'channels': list(KNOWN_BUS_CHANNELS)})


@app.post('/api/bus/send')
def send_bus_message():
    body = request.get_json(silent=True) or {}
    target_device_id = str(body.get('target_device_id') or body.get('device_id') or '').strip()
    channel = normalize_bus_channel(body.get('channel'))
    payload_text = normalize_payload_text(
        body.get('payload_text') if body.get('payload_text') is not None else body.get('payload')
    )
    if not target_device_id:
        return json_response({'ok': False, 'message': 'target_device_id is required'}, 400)
    if channel not in ALLOWED_BUS_CHANNELS:
        return json_response({'ok': False, 'message': '当前云端只开放 notify 消息'}, 400)
    if not payload_text:
        return json_response({'ok': False, 'message': 'payload_text is required'}, 400)

    requested_by = requested_by_value()
    with db_connect() as conn:
        device = conn.execute(
            "select device_id from cloud_devices where device_id = %s",
            (target_device_id,),
        ).fetchone()
        if not device:
            return json_response({'ok': False, 'message': 'device not found'}, 404)
        message_id = create_bus_message(
            conn,
            'cloud',
            'cloud',
            'device',
            target_device_id,
            channel,
            payload_text,
            requested_by,
            payload_json={'request': body},
        )
        payload = bus_message_payload(
            message_id,
            'cloud',
            'cloud',
            'device',
            target_device_id,
            channel,
            'text',
            payload_text,
        )
        ok, message = publish_bus_message(conn, message_id, target_device_id, payload)
        row = conn.execute(
            """
            select *
            from cloud_bus_messages
            where message_id = %s
            """,
            (message_id,),
        ).fetchone()
    status = 200 if ok else 503
    return json_response({'ok': ok, 'message': message, 'bus_message': row}, status)


@app.get('/api/bus/subscriptions')
def list_bus_subscriptions():
    with db_connect() as conn:
        rows = conn.execute(
            """
            select s.*, src.display_name as source_display_name, sub.display_name as subscriber_display_name
            from cloud_message_subscriptions s
            left join cloud_devices src on s.source_type = 'device' and s.source_id = src.device_id
            left join cloud_devices sub on s.subscriber_type = 'device' and s.subscriber_id = sub.device_id
            order by s.created_at desc
            limit 200
            """
        ).fetchall()
    return json_response({'ok': True, 'subscriptions': rows})


@app.post('/api/bus/subscriptions')
def save_bus_subscription():
    body = request.get_json(silent=True) or {}
    source_id = str(body.get('source_id') or '').strip()
    subscriber_type = str(body.get('subscriber_type') or 'device').strip().lower()
    subscriber_id = str(body.get('subscriber_id') or '').strip()
    channel = normalize_bus_channel(body.get('channel'))
    enabled = bool_value(body.get('enabled', True))
    if not source_id:
        return json_response({'ok': False, 'message': 'source_id is required'}, 400)
    if subscriber_type not in ('device', 'cloud'):
        return json_response({'ok': False, 'message': 'subscriber_type must be device/cloud'}, 400)
    if subscriber_type == 'device' and not subscriber_id:
        return json_response({'ok': False, 'message': 'subscriber_id is required'}, 400)
    if subscriber_type == 'cloud':
        subscriber_id = 'cloud'
    if not channel:
        return json_response({'ok': False, 'message': 'channel is required'}, 400)

    with db_connect() as conn:
        source = conn.execute(
            "select device_id from cloud_devices where device_id = %s",
            (source_id,),
        ).fetchone()
        if not source:
            return json_response({'ok': False, 'message': 'source device not found'}, 404)
        if subscriber_type == 'device':
            target = conn.execute(
                "select device_id from cloud_devices where device_id = %s",
                (subscriber_id,),
            ).fetchone()
            if not target:
                return json_response({'ok': False, 'message': 'subscriber device not found'}, 404)
        conn.execute(
            """
            insert into cloud_message_subscriptions (
              id, subscriber_type, subscriber_id, source_type, source_id, channel,
              enabled, route_json, created_at, updated_at
            )
            values (%s, %s, %s, 'device', %s, %s, %s, %s, now(), now())
            on conflict (subscriber_type, subscriber_id, source_type, source_id, channel)
            do update set enabled = excluded.enabled, updated_at = now()
            """,
            (
                uuid4(),
                subscriber_type,
                subscriber_id,
                source_id,
                channel,
                enabled,
                Jsonb({'local_route': channel}),
            ),
        )
    return json_response({'ok': True})


init_db()
start_mqtt()
start_cloud_ws_server()


if __name__ == '__main__':
    app.run(
        host=os.environ.get('APP_HOST', '0.0.0.0'),
        port=int(os.environ.get('APP_PORT', '18088')),
        debug=False,
        use_reloader=False,
    )
