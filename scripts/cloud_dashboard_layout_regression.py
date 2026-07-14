#!/usr/bin/env python3
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
CLOUD_HTML = ROOT / 'tools' / 'remote_mqtt_python' / 'static' / 'cloud.html'


REQUIRED_MARKERS = [
    'class="app-shell"',
    'class="sidebar"',
    'class="workspace"',
    'class="page-toolbar"',
    'class="user-menu"',
    'class="user-dropdown"',
    'Wireless Debug',
    '设备管理',
    '消息中心',
    '系统设置',
    '退出登录',
]


def main():
    html = CLOUD_HTML.read_text(encoding='utf-8')
    missing = [marker for marker in REQUIRED_MARKERS if marker not in html]
    if missing:
        print('cloud dashboard layout regression failed')
        for marker in missing:
            print(f'missing marker: {marker}')
        return 1
    print('cloud dashboard layout regression passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
