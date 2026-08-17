import base64
import unittest

from remote_excel_codec import decode_base64_file


class RemoteExcelCodecTest(unittest.TestCase):
    def test_decodes_base64_file(self):
        encoded = base64.b64encode(b'xlsx-test').decode('ascii')
        self.assertEqual(decode_base64_file(encoded, 32), b'xlsx-test')

    def test_rejects_invalid_base64(self):
        with self.assertRaisesRegex(ValueError, 'invalid base64'):
            decode_base64_file('not base64!', 32)

    def test_rejects_decoded_file_over_limit(self):
        encoded = base64.b64encode(b'12345').decode('ascii')
        with self.assertRaisesRegex(ValueError, 'file too large'):
            decode_base64_file(encoded, 4)


if __name__ == '__main__':
    unittest.main()
