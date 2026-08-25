import re


LEGACY_AUTO_DISPLAY_NAME = re.compile(r'^ESP32-\d{3,}$', re.IGNORECASE)
VALID_NAME_SEGMENT = re.compile(r'^[A-Za-z0-9]+$')


def normalize_display_name(value):
    if value is None:
        return None
    name = str(value).strip()
    return name[:128] if name else None


def auto_display_name_from_ap_ssid(ap_ssid):
    value = str(ap_ssid or '').strip()
    parts = [part for part in value.split('_') if part]
    if len(parts) < 2:
        return None

    first = parts[0].split('-', 1)[0]
    last = parts[-1]
    if not VALID_NAME_SEGMENT.fullmatch(first) or not VALID_NAME_SEGMENT.fullmatch(last):
        return None
    return f'{first.upper()}_{last.upper()}'[:128]


def auto_display_name_from_device_mac(device_mac):
    compact = re.sub(r'[^0-9A-Fa-f]', '', str(device_mac or ''))
    if len(compact) != 12:
        return None
    try:
        softap_mac = (int(compact, 16) + 1) & ((1 << 48) - 1)
    except ValueError:
        return None
    return f'ESP32_{softap_mac & 0xFFFF:04X}'


def auto_display_name_from_device_id(device_id):
    value = str(device_id or '').strip()
    compact = value[3:] if value.lower().startswith('wd-') else value
    if not re.fullmatch(r'[0-9A-Fa-f]{12}', compact):
        return None
    return auto_display_name_from_device_mac(compact)


def is_legacy_auto_display_name(display_name):
    return bool(LEGACY_AUTO_DISPLAY_NAME.fullmatch(str(display_name or '').strip()))


def _unique_name(base_name, used_names):
    used = {
        str(name).strip().casefold()
        for name in (used_names or ())
        if str(name or '').strip()
    }
    if base_name.casefold() not in used:
        return base_name

    index = 2
    while True:
        suffix = f'_{index}'
        candidate = f'{base_name[:128 - len(suffix)]}{suffix}'
        if candidate.casefold() not in used:
            return candidate
        index += 1


def choose_device_display_name(
    current_name,
    *,
    ap_ssid=None,
    device_mac=None,
    device_id=None,
    used_names=(),
):
    current = normalize_display_name(current_name)
    if current and not is_legacy_auto_display_name(current):
        return current

    base_name = (
        auto_display_name_from_ap_ssid(ap_ssid)
        or auto_display_name_from_device_mac(device_mac)
        or auto_display_name_from_device_id(device_id)
    )
    if base_name is None:
        return current
    return _unique_name(base_name, used_names)
