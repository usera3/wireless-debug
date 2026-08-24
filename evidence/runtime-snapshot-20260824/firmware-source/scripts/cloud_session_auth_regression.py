#!/usr/bin/env python3
import argparse
import http.cookiejar
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


def build_opener(insecure=False):
    cookie_jar = http.cookiejar.CookieJar()
    handlers = [urllib.request.HTTPCookieProcessor(cookie_jar)]
    if insecure:
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
    return urllib.request.build_opener(*handlers)


def request(opener, url, method='GET', data=None):
    encoded = None
    headers = {}
    if data is not None:
        encoded = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=encoded, headers=headers, method=method)
    try:
        return opener.open(req, timeout=12)
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
    parser.add_argument('--insecure', action='store_true')
    args = parser.parse_args()

    base_url = args.base_url.rstrip('/')
    assert_condition(args.password, 'password is required; pass --password or set CLOUD_TEST_PASSWORD')
    opener = build_opener(insecure=args.insecure)

    cloud_response = request(opener, f'{base_url}/cloud.html')
    assert_condition(cloud_response.status == 200, 'cloud.html should resolve through login redirect')
    assert_condition(
        cloud_response.geturl().startswith(f'{base_url}/login'),
        f'cloud.html should redirect to login, got {cloud_response.geturl()}',
    )
    login_body = cloud_response.read().decode('utf-8', errors='replace')
    assert_condition('无线调试云端观测台' in login_body, 'login page title missing')
    assert_condition(
        cloud_response.headers.get('WWW-Authenticate') is None,
        'login redirect must not trigger browser Basic Auth',
    )

    remote_path = f'/remote/{urllib.parse.quote(args.device_id)}/orig/i.html'
    remote_response = request(opener, f'{base_url}{remote_path}')
    assert_condition(remote_response.status == 200, 'remote page should resolve through login redirect')
    assert_condition(
        remote_response.geturl().startswith(f'{base_url}/login'),
        f'remote page should redirect to login, got {remote_response.geturl()}',
    )

    login_response = request(
        opener,
        f'{base_url}/login?next=/cloud.html',
        method='POST',
        data={'username': args.username, 'password': args.password},
    )
    assert_condition(login_response.status in (200, 302), f'login returned {login_response.status}')
    post_login_response = request(opener, f'{base_url}/cloud.html')
    assert_condition(post_login_response.status == 200, f'authenticated cloud.html returned {post_login_response.status}')
    assert_condition(
        '/login' not in post_login_response.geturl(),
        f'authenticated cloud.html still redirects to login: {post_login_response.geturl()}',
    )

    logout_response = request(opener, f'{base_url}/logout')
    assert_condition(logout_response.status == 200, f'logout returned {logout_response.status}')
    assert_condition(
        logout_response.geturl().startswith(f'{base_url}/login'),
        f'logout should redirect to login, got {logout_response.geturl()}',
    )
    after_logout_response = request(opener, f'{base_url}/cloud.html')
    assert_condition(
        after_logout_response.geturl().startswith(f'{base_url}/login'),
        f'cloud.html should redirect to login after logout, got {after_logout_response.geturl()}',
    )

    print('cloud session auth regression passed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'cloud session auth regression failed: {exc}', file=sys.stderr)
        sys.exit(1)
