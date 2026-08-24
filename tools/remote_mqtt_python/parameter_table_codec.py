"""Validation and normalization for browser-uploaded parameter table data."""

import math
import re


class ParameterTableError(ValueError):
    pass


_ID_RE = re.compile(r'^(\d{3})-(\d{3})$')
_CONTROL_RE = re.compile(r'[\x00-\x1f]')
MAX_PAGES = 64
MAX_PARAMS = 4096


def _string(value, field, *, non_empty=False, max_length=2000):
    if not isinstance(value, str) or len(value) > max_length or _CONTROL_RE.search(value):
        raise ParameterTableError(f'{field} must be a valid string')
    result = value.strip() if non_empty else value
    if non_empty and not result:
        raise ParameterTableError(f'{field} must not be empty')
    return result


def _number(value, field, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ParameterTableError(f'{field} must be a finite number')
    if integer and int(value) != value:
        raise ParameterTableError(f'{field} must be an integer')
    return int(value) if integer else value


def _boolean(value, field):
    if not isinstance(value, bool):
        raise ParameterTableError(f'{field} must be boolean')
    return value


def normalize_parameter_table(payload):
    if not isinstance(payload, dict):
        raise ParameterTableError('parameter table must be an object')
    if payload.get('version') != 1:
        raise ParameterTableError('unsupported parameter table version')

    name = _string(payload.get('name'), 'name', non_empty=True, max_length=180).replace('\\', '/')
    if '/' in name or name in ('.', '..'):
        raise ParameterTableError('name must be a file name')

    raw_pages = payload.get('pages')
    if not isinstance(raw_pages, list) or not raw_pages or len(raw_pages) > MAX_PAGES:
        raise ParameterTableError('pages must be a non-empty array')
    pages = [_string(page, f'pages[{index}]', non_empty=True, max_length=64)
             for index, page in enumerate(raw_pages)]
    if len(set(pages)) != len(pages):
        raise ParameterTableError('pages must be unique')
    page_set = set(pages)

    raw_params = payload.get('params')
    if not isinstance(raw_params, list) or len(raw_params) > MAX_PARAMS:
        raise ParameterTableError('params must be an array')

    params = []
    ids = set()
    for index, value in enumerate(raw_params):
        field = f'params[{index}]'
        if not isinstance(value, dict):
            raise ParameterTableError(f'{field} must be an object')
        identifier = _string(value.get('id'), f'{field}.id', non_empty=True, max_length=16)
        match = _ID_RE.fullmatch(identifier)
        if not match:
            raise ParameterTableError(f'{field}.id must match PPP-NNN')
        reg_addr = _number(value.get('regAddr'), f'{field}.regAddr', integer=True)
        expected = int(match.group(1)) * 256 + int(match.group(2))
        if reg_addr != expected:
            raise ParameterTableError(f'{field}.regAddr must match id')
        if identifier in ids:
            raise ParameterTableError('parameter ids must be unique')
        ids.add(identifier)

        page = _string(value.get('page'), f'{field}.page', non_empty=True, max_length=64)
        if page not in page_set:
            raise ParameterTableError(f'{field}.page must be listed in pages')
        decimals = _number(value.get('decimals'), f'{field}.decimals', integer=True)
        if decimals < 0 or decimals > 16:
            raise ParameterTableError(f'{field}.decimals out of range')
        params.append({
            'id': identifier,
            'regAddr': reg_addr,
            'alias': _string(value.get('alias'), f'{field}.alias', max_length=180),
            'name': _string(value.get('name'), f'{field}.name', max_length=180),
            'unit': _string(value.get('unit'), f'{field}.unit', max_length=180),
            'desc': _string(value.get('desc'), f'{field}.desc', max_length=2000),
            'decimals': decimals,
            'signed': _boolean(value.get('signed'), f'{field}.signed'),
            'isFloat': _boolean(value.get('isFloat'), f'{field}.isFloat'),
            'readOnly': _boolean(value.get('readOnly'), f'{field}.readOnly'),
            'hidden': _boolean(value.get('hidden'), f'{field}.hidden'),
            'max': _number(value.get('max'), f'{field}.max'),
            'min': _number(value.get('min'), f'{field}.min'),
            'defaultVal': _number(value.get('defaultVal'), f'{field}.defaultVal'),
            'page': page,
        })

    return {'version': 1, 'name': name, 'pages': pages, 'params': params}
