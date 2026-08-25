#!/usr/bin/env python3
import argparse
import http.cookiejar
import os
import urllib.error
import re
import sys
import urllib.parse
import urllib.request


def build_opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, url, data=None):
    body = None
    headers = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        return opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=12)
    except urllib.error.HTTPError as exc:
        return exc


def assert_condition(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--username', default='admin@admin.com')
    parser.add_argument('--password', default=os.environ.get('CLOUD_TEST_PASSWORD', ''))
    parser.add_argument('--device-id', default='wd-ac276eab7c9c')
    args = parser.parse_args()

    base_url = args.base_url.rstrip('/')
    assert_condition(args.password, 'password is required; pass --password or set CLOUD_TEST_PASSWORD')
    parsed = urllib.parse.urlparse(base_url)
    opener = build_opener()

    request(
        opener,
        f'{base_url}/login',
        data={'username': args.username, 'password': args.password, 'next': '/cloud.html'},
    ).read()

    remote_url = f'{base_url}/remote/{urllib.parse.quote(args.device_id)}/orig/i.html'
    html = request(opener, remote_url).read().decode('utf-8', errors='replace')
    assert_condition('ws://43.153.137.20' not in html, 'remote page must not inject plain ws:// public IP')
    assert_condition('http://43.153.137.20' not in html, 'remote page must not inject plain http:// public IP')

    expected_ws = f'wss://{parsed.netloc}/ws/device/{urllib.parse.quote(args.device_id)}'
    assert_condition(expected_ws in html, f'remote page should inject {expected_ws}')

    ws_probe = request(opener, f'{base_url}/ws/device/{urllib.parse.quote(args.device_id)}')
    body = ws_probe.read().decode('utf-8', errors='replace')
    assert_condition(
        not re.search(r'/login|欢迎回来|authentication required', body, re.I),
        'HTTPS /ws/device path must not be served by login/cloud HTTP app',
    )
    print('cloud remote console https regression passed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'cloud remote console https regression failed: {exc}', file=sys.stderr)
        sys.exit(1)
