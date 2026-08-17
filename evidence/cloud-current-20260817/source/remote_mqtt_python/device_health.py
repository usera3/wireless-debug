"""Pure current-state health scoring for cloud device records."""

from __future__ import annotations

from datetime import datetime, timezone


def _dict(value):
    return value if isinstance(value, dict) else {}


def _int(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _bool(value):
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def _nested_number(payload, *path):
    value = payload
    for key in path:
        value = _dict(value).get(key)
    return _int(value)


def extract_cloud_metrics(payload):
    payload = _dict(payload)
    heap = _dict(payload.get('heap'))
    display = _dict(payload.get('display'))
    menu = _dict(payload.get('menu'))
    motor_params = _dict(payload.get('motor_params'))
    comm = _dict(payload.get('comm_stats'))
    comm_error_total = sum(value or 0 for value in [
        _nested_number(comm, 'uart', 'tx_failures'),
        _nested_number(comm, 'uart', 'overflows'),
        _nested_number(comm, 'ble', 'notify_failures'),
        _nested_number(comm, 'ble', 'no_subscriber_drops'),
        _nested_number(comm, 'ble', 'alloc_failures'),
        _nested_number(comm, 'wifi', 'tx_failures'),
        _nested_number(comm, 'wifi', 'no_client_drops'),
        _nested_number(comm, 'wifi', 'pool_exhausted'),
        _nested_number(comm, 'wifi', 'queue_full'),
        _nested_number(comm, 'wifi', 'httpd_queue_failures'),
        _nested_number(comm, 'wifi', 'rx_failures'),
        _nested_number(comm, 'route', 'idle_drops'),
        _nested_number(comm, 'route', 'unavailable_drops'),
        _nested_number(comm, 'route', 'partial_drops'),
    ])
    return {
        'device_mac': payload.get('device_mac'),
        'heap_free': _int(heap.get('free')),
        'heap_min_free': _int(heap.get('min_free')),
        'heap_largest': _int(heap.get('largest')),
        'heap_internal_free': _int(heap.get('internal_free')),
        'heap_internal_min_free': _int(heap.get('internal_min_free')),
        'restart_reason': _int(payload.get('restart_reason')),
        'comm_error_total': comm_error_total,
        'display_status': display.get('status'),
        'display_backend': display.get('backend'),
        'display_enabled': _bool(display.get('enabled')),
        'menu_active': _bool(menu.get('active')),
        'menu_title': menu.get('title'),
        'menu_message': menu.get('message'),
        'motor_param_count': _int(motor_params.get('count')),
        'motor_param_capacity': _int(motor_params.get('capacity')),
    }


def _bool_from_device(device, key):
    if key in device and device.get(key) is not None:
        return _bool(device.get(key))
    return _bool(_dict(device.get('last_status_json')).get(key))


def _status_age_seconds(last_seen_at):
    if not last_seen_at:
        return None
    if last_seen_at.tzinfo is None:
        last_seen_at = last_seen_at.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - last_seen_at).total_seconds()))


def diagnose_device_state(device):
    payload = _dict(device.get('last_status_json'))
    metrics = extract_cloud_metrics(payload)
    cloud_state = device.get('cloud_state') or 'unknown'
    net_mode = str(device.get('net_mode') or payload.get('net_mode') or '').lower()
    age_seconds = _status_age_seconds(device.get('last_seen_at'))
    if cloud_state == 'unknown':
        return {'health_score': 0, 'diagnostic_level': 'unknown',
                'diagnostic_text': '尚未收到状态上报',
                'diagnostic_reasons': ['尚未收到设备状态上报'],
                'status_age_seconds': age_seconds}
    if cloud_state == 'offline':
        return {'health_score': 20, 'diagnostic_level': 'offline',
                'diagnostic_text': '设备离线',
                'diagnostic_reasons': ['超过心跳窗口未收到设备状态'],
                'status_age_seconds': age_seconds}

    score = 100
    reasons = []
    if age_seconds is not None and age_seconds > 20:
        score -= 15
        reasons.append(f'最近状态上报已过去 {age_seconds} 秒')
    if net_mode in ('sta', 'apsta') and not _bool_from_device(device, 'sta_connected'):
        score -= 35
        reasons.append('STA 当前未连接')
    if net_mode in ('sta', 'apsta') and not _bool_from_device(device, 'sta_configured'):
        score -= 10
        reasons.append('STA 尚未保存配置')
    if _bool_from_device(device, 'sta_connecting'):
        score -= 8
        reasons.append('STA 正在连接中')
    if not _bool_from_device(device, 'ble_ready'):
        score -= 10
        reasons.append('BLE 未启动')
    if metrics['heap_internal_free'] is not None and metrics['heap_internal_free'] < 32000:
        score -= 12
        reasons.append('内部堆内存偏低')
    if metrics['heap_free'] is not None and metrics['heap_free'] < 120000:
        score -= 8
        reasons.append('总可用堆内存偏低')
    if metrics['restart_reason'] is not None and metrics['restart_reason'] not in (1,):
        score -= 5
        reasons.append(f'重启原因码 {metrics["restart_reason"]}')

    score = max(0, min(100, score))
    level, text = ('normal', '状态正常') if score >= 85 else (
        ('attention', '需要关注') if score >= 60 else ('warning', '需要检查'))
    if not reasons:
        reasons.append('心跳、STA、BLE 与云端 MQTT 状态正常')
    return {'health_score': score, 'diagnostic_level': level,
            'diagnostic_text': text, 'diagnostic_reasons': reasons,
            'status_age_seconds': age_seconds, **metrics}
