"""Small, dependency-free codecs for remote parameter-table uploads."""

import base64
import binascii


def decode_base64_file(value, max_bytes):
    if not isinstance(value, str) or not value:
        raise ValueError('base64 file data required')

    max_encoded = ((max_bytes + 2) // 3) * 4
    if len(value) > max_encoded:
        raise ValueError('file too large')

    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError('invalid base64 file data') from exc

    if not data:
        raise ValueError('empty file')
    if len(data) > max_bytes:
        raise ValueError('file too large')
    return data
