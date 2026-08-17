import unittest

from parameter_table_codec import ParameterTableError, normalize_parameter_table


def table(**overrides):
    value = {
        'version': 1,
        'name': 'ParameterTable.xlsx',
        'pages': ['BASE'],
        'params': [{
            'id': '000-001',
            'regAddr': 1,
            'alias': 'VBASE',
            'name': 'VBASE',
            'unit': '0.1V',
            'desc': '',
            'decimals': 0,
            'signed': False,
            'isFloat': False,
            'readOnly': False,
            'hidden': False,
            'max': 65535,
            'min': 0,
            'defaultVal': 6666,
            'page': 'BASE',
        }],
    }
    value.update(overrides)
    return value


class ParameterTableCodecTest(unittest.TestCase):
    def test_normalizes_supported_structured_table(self):
        result = normalize_parameter_table(table())
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['params'][0]['regAddr'], 1)

    def test_rejects_address_that_does_not_match_id(self):
        with self.assertRaisesRegex(ParameterTableError, 'regAddr must match id'):
            normalize_parameter_table(table(params=[{**table()['params'][0], 'regAddr': 2}]))

    def test_rejects_unknown_page(self):
        with self.assertRaisesRegex(ParameterTableError, 'page must be listed in pages'):
            normalize_parameter_table(table(params=[{**table()['params'][0], 'page': 'MISSING'}]))


if __name__ == '__main__':
    unittest.main()
