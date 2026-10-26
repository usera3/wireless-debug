"""Exercise real Flask entry/auth/runtime functions without starting MQTT or DB."""
import ast
import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import quote, urlparse

from flask import Flask, Response, jsonify, redirect, request, send_from_directory, session, url_for

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'cloud/app.py'
if not BACKEND.exists():
    BACKEND = ROOT / 'tools/remote_mqtt_python/app.py'
NAMES = {
    'root', 'cloud', 'cloud_html', 'index_html', 'legacy_cloud_html',
    'cloud_ws_public_url', 'inject_react_runtime', 'remote_console_rewrite_script',
    'react_load_fallback_script', 'render_react_app', 'react_root_asset',
    'render_remote_console_html', 'remote_console_asset_version',
    'remote_console_index', 'remote_console_asset', 'require_cloud_login',
    'credentials_match', 'wants_json_response', 'current_request_path', 'safe_next_path',
}

def load_entries(asset_dir):
    app = Flask(__name__)
    app.secret_key = 'isolated-test-only'
    scope = dict(globals(), app=app, ORIG_WEB_DIR=asset_dir,
                 BASE_DIR=BACKEND.parent, CLOUD_WS_PUBLIC_URL='', CLOUD_WS_PORT=18089,
                 CLOUD_HTTP_USER='', CLOUD_HTTP_PASSWORD='',
                 json_response=lambda body, status: (jsonify(body), status))
    tree = ast.parse(BACKEND.read_text(encoding='utf-8'))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in NAMES]
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(BACKEND), 'exec'), scope)
    app.add_url_rule('/login', 'login', lambda: 'login')
    return app, scope

class EntryTests(unittest.TestCase):
    def test_cloud_index_aliases_runtime_remote_and_auth(self):
        with tempfile.TemporaryDirectory(prefix='wd-entry-') as temp:
            assets = Path(temp)
            (assets / 'i.html').write_text('<html><head></head><body><div id="root"></div></body></html>')
            app, scope = load_entries(assets)
            client = app.test_client()
            response = client.get('/index.html')
            self.assertEqual(response.status_code, 200)
            self.assertIn('window.__WIRELESS_RUNTIME_MODE = "cloud-platform"', response.get_data(as_text=True))
            self.assertIn('no-store', response.headers['Cache-Control'])
            for entry in ['/', '/cloud', '/cloud.html']:
                with self.subTest(entry=entry):
                    response = client.get(entry + '?source=legacy')
                    self.assertEqual(response.status_code, 302)
                    target = urlparse(response.headers['Location'])
                    self.assertEqual((target.path, target.query), ('/index.html', 'source=legacy'))
            with client.get('/legacy-cloud.html') as legacy:
                self.assertEqual(legacy.status_code, 200)
            remote = client.get('/remote/wd-one/orig/i.html')
            self.assertEqual(remote.status_code, 200)
            self.assertIn('const rewriteHttp', remote.get_data(as_text=True))
            self.assertIn('"wd-one"', remote.get_data(as_text=True))
            scope.update(CLOUD_HTTP_USER='test@example.com', CLOUD_HTTP_PASSWORD='test')
            self.assertEqual(client.get('/index.html').status_code, 302)
            self.assertEqual(client.get('/index.html', headers={'Accept': 'application/json'}).status_code, 401)
            with client.session_transaction() as state:
                state['cloud_authenticated'] = True
            self.assertEqual(client.get('/index.html').status_code, 200)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--rewrite':
        app, scope = load_entries(Path('.'))
        with app.test_request_context('/'):
            print(scope['remote_console_rewrite_script'](sys.argv[2]))
    else:
        unittest.main()
