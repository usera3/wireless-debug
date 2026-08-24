import ast
import unittest
from pathlib import Path


APP_PATH = Path(__file__).with_name('app.py')


def flask_config_keywords():
    tree = ast.parse(APP_PATH.read_text(encoding='utf-8'), filename=str(APP_PATH))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (
            isinstance(func, ast.Attribute)
            and func.attr == 'update'
            and isinstance(func.value, ast.Attribute)
            and func.value.attr == 'config'
            and isinstance(func.value.value, ast.Name)
            and func.value.value.id == 'app'
        ):
            continue
        return {
            keyword.arg: keyword.value
            for keyword in node.keywords
            if keyword.arg is not None
        }
    raise AssertionError('app.config.update(...) not found')


class AuthCookieConfigTest(unittest.TestCase):
    def test_session_cookie_uses_service_specific_name(self):
        config = flask_config_keywords()
        cookie_name = config.get('SESSION_COOKIE_NAME')
        self.assertIsNotNone(cookie_name, 'SESSION_COOKIE_NAME is not configured')
        self.assertEqual(ast.literal_eval(cookie_name), 'wireless_debug_session')


if __name__ == '__main__':
    unittest.main()
