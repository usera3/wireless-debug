#!/usr/bin/env python3
import argparse
import http.cookiejar
import os
import sys
import urllib.parse
import urllib.request


def request(opener, url, data=None):
    body = None
    headers = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=12)


def assert_condition(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--username', default='admin@admin.com')
    parser.add_argument('--password', default=os.environ.get('CLOUD_TEST_PASSWORD', ''))
    args = parser.parse_args()
    assert_condition(args.password, 'password is required; pass --password or set CLOUD_TEST_PASSWORD')

    base_url = args.base_url.rstrip('/')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request(opener, f'{base_url}/login', data={'username': args.username, 'password': args.password}).read()
    html = request(opener, f'{base_url}/cloud.html').read().decode('utf-8', errors='replace')
    assert_condition('__WIRELESS_RUNTIME_MODE' in html, 'cloud.html must inject runtime mode')
    assert_condition('cloud-platform' in html, 'cloud.html must inject cloud-platform mode')
    assert_condition('./a.js' in html or 'src="./a.js' in html, 'cloud.html must serve React app assets')
    assert_condition('class="app-shell"' not in html, 'cloud.html must not serve the legacy standalone dashboard')
    legacy = request(opener, f'{base_url}/legacy-cloud.html').read().decode('utf-8', errors='replace')
    assert_condition('class="app-shell"' in legacy, 'legacy-cloud.html should keep the old dashboard during migration')
    print('cloud platform React route regression passed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'cloud platform React route regression failed: {exc}', file=sys.stderr)
        sys.exit(1)
