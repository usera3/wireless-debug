#!/usr/bin/env python3
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
APP_PY = ROOT / 'tools' / 'remote_mqtt_python' / 'app.py'
REACT_HTML = ROOT / 'dist' / 'orig' / 'i.html'
LEGACY_CLOUD_HTML = ROOT / 'tools' / 'remote_mqtt_python' / 'static' / 'cloud.html'


REQUIRED_MARKERS = [
    "def render_react_app(runtime_mode, device_id=None):",
    "@app.get('/cloud.html')",
    "return render_react_app('cloud-platform')",
    "@app.get('/legacy-cloud.html')",
    "__WIRELESS_RUNTIME_MODE",
    "return render_react_app('cloud-device', device_id)",
    "@app.get('/a.js')",
    "@app.get('/x.js')",
]

REACT_MARKERS = [
    '<title>无线调试云端观测台</title>',
    'src="./a.js"',
    'href="./a.css"',
]


def main():
    app_py = APP_PY.read_text(encoding='utf-8')
    react_html = REACT_HTML.read_text(encoding='utf-8')
    legacy_html = LEGACY_CLOUD_HTML.read_text(encoding='utf-8')

    missing = [marker for marker in REQUIRED_MARKERS if marker not in app_py]
    missing += [marker for marker in REACT_MARKERS if marker not in react_html]
    if 'class="app-shell"' not in legacy_html:
        missing.append('legacy cloud dashboard app-shell')

    if missing:
        print('cloud dashboard layout regression failed')
        for marker in missing:
            print(f'missing marker: {marker}')
        return 1
    print('cloud dashboard layout regression passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
