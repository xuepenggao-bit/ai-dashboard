#!/usr/bin/env python3
"""Small independent fallback for the market-environment KPI cards.

All values retain provider observation dates/times. ``checkedAt`` is only the
time this task checked the sources, never a substitute for a quote timestamp.
Tencent board market caps are already CNY 100m (field 45); HSI daily field 5
is HKD turnover, and Eastmoney RZRQYE is CNY. No magnitude-based unit guessing.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/market_kpis.json'
TZ = dt.timezone(dt.timedelta(hours=8))
CAP_CODES = ('sh000002', 'sz399107', 'sz399102', 'sh000680')
PE_CODES = {'sh000001': '000001.SH', 'sz399001': '399001.SZ',
            'sz399006': '399006.SZ', 'sh000688': '000688.SH'}
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
           'Accept': 'application/json, text/plain, */*', 'Referer': 'https://quote.eastmoney.com/'}


def local_now():
    return dt.datetime.now(TZ)


def as_now(now=None):
    value = now or local_now()
    return value.replace(tzinfo=TZ) if value.tzinfo is None else value.astimezone(TZ)


def number(value):
    if isinstance(value, bool) or value is None or isinstance(value, str) and not value.strip():
        raise ValueError('missing/non-numeric observation')
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('nonfinite observation')
    return result


def valid_date(value, now=None):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('invalid source date')
    date = dt.date.fromisoformat(value)
    if date.weekday() >= 5 or date > as_now(now).date():
        raise ValueError('future/weekend source date')
    return date


def quote_timestamp(value, now=None):
    text = str(value or '').strip()
    stamp = None
    for fmt in ('%Y%m%d%H%M%S', '%Y/%m/%d %H:%M:%S', '%Y-%m-%d %H:%M:%S'):
        try:
            stamp = dt.datetime.strptime(text, fmt).replace(tzinfo=TZ)
            break
        except ValueError:
            pass
    if stamp is None:
        raise ValueError('missing source quote time')
    current = as_now(now)
    if stamp > current + dt.timedelta(minutes=2) or current - stamp > dt.timedelta(days=21):
        raise ValueError('future or expired source quote')
    valid_date(stamp.date().isoformat(), current)
    return int(stamp.timestamp() * 1000)


def validate_quote(raw, kind, now=None):
    if not isinstance(raw, dict):
        raise ValueError('malformed quote')
    code = raw.get('code')
    allowed = CAP_CODES if kind == 'caps' else PE_CODES
    if code not in allowed:
        raise ValueError('wrong security identity')
    timestamp = number(raw.get('quoteTs'))
    current = as_now(now)
    if timestamp != int(timestamp) or timestamp <= 0:
        raise ValueError('invalid quote time')
    source_time = dt.datetime.fromtimestamp(timestamp / 1000, TZ)
    valid_date(source_time.date().isoformat(), current)
    if source_time > current + dt.timedelta(minutes=2) or current - source_time > dt.timedelta(days=21):
        raise ValueError('future or expired quote')
    field = 'totalCapYi' if kind == 'caps' else 'pe'
    value = number(raw.get(field))
    if not (100 <= value <= 3_000_000 if kind == 'caps' else 3 < value < 2000):
        raise ValueError('invalid cap or PE observation')
    result = {'code': code, field: value, 'quoteTs': int(timestamp)}
    if kind == 'pe':
        if raw.get('secucode', PE_CODES[code]) != PE_CODES[code]:
            raise ValueError('wrong PE security mapping')
        result['secucode'] = PE_CODES[code]
    return result


def validate_caps(quotes, now=None):
    if not isinstance(quotes, list) or len(quotes) != len(CAP_CODES):
        raise ValueError('incomplete board cap snapshot')
    rows = [validate_quote(q, 'caps', now) for q in quotes]
    values = {q['code']: q for q in rows}
    if len(values) != 4 or len({dt.datetime.fromtimestamp(q['quoteTs'] / 1000, TZ).date() for q in rows}) != 1:
        raise ValueError('duplicate or mixed-day caps')
    sh, sz, gem, star = (values[code]['totalCapYi'] for code in CAP_CODES)
    if sh <= star or sz <= gem:
        raise ValueError('board cap decomposition does not conserve total')
    return [values[code] for code in CAP_CODES]


def parse_tencent(text, now=None):
    caps, pe = [], []
    for match in re.finditer(r'v_([a-z0-9]+)="([^"\n]*)"', str(text)):
        code, fields = match[1], match[2].split('~')
        if code not in CAP_CODES and code not in PE_CODES:
            continue
        try:
            if len(fields) <= 45 or fields[2] != code[2:]:
                raise ValueError('Tencent identity/fields mismatch')
            timestamp = quote_timestamp(fields[30], now)
            if code in CAP_CODES:
                caps.append(validate_quote({'code': code, 'totalCapYi': number(fields[45]), 'quoteTs': timestamp}, 'caps', now))
            if code in PE_CODES:
                pe.append(validate_quote({'code': code, 'pe': number(fields[39]), 'quoteTs': timestamp}, 'pe', now))
        except (ValueError, TypeError, OverflowError, OSError):
            continue  # A bad PE observation must not clear valid board caps.
    try:
        caps = validate_caps(caps, now)
    except ValueError:
        caps = []
    unique_pe = {q['code']: q for q in pe}
    return {'caps': caps, 'pe': [unique_pe[code] for code in PE_CODES if code in unique_pe]}


def validate_hk_rows(rows, now=None):
    if not isinstance(rows, list) or len(rows) < 20 or len(rows) > 100:
        raise ValueError('HK amount history incomplete')
    result, previous = [], ''
    current = as_now(now)
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError('malformed HK amount')
        date = str(raw.get('date', ''))
        valid_date(date, current)
        amount = number(raw.get('amountYi'))
        if date <= previous or not 0 < amount < 1_000_000 or raw.get('status') not in ('live', 'close'):
            raise ValueError('invalid/duplicate HK amount')
        item = {'date': date, 'amountYi': amount, 'status': raw['status']}
        time_label = raw.get('asOf')
        if time_label is not None:
            if not isinstance(time_label, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', time_label):
                raise ValueError('invalid HK source time')
            minute = int(time_label[:2]) * 60 + int(time_label[3:])
            if minute < 570 or date == current.date().isoformat() and minute > current.hour * 60 + current.minute + 1:
                raise ValueError('future HK amount time')
            item['asOf'] = time_label
        if date == current.date().isoformat() and not time_label:
            raise ValueError('today HK amount requires actual provider time')
        previous = date
        result.append(item)
    return result[-60:]


def parse_hk_amount(payload, now=None):
    current = as_now(now)
    block = payload.get('data', {}).get('hkHSI') if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get('code') != 0 or not isinstance(block, dict):
        raise ValueError('HK amount source missing')
    qt = block.get('qt', {}).get('hkHSI')
    if not isinstance(qt, list) or len(qt) <= 30 or qt[2] != 'HSI':
        raise ValueError('HK amount identity missing')
    observed = dt.datetime.fromtimestamp(quote_timestamp(qt[30], current) / 1000, TZ)
    raw_rows = block.get('day') or block.get('qfqday')
    if not isinstance(raw_rows, list):
        raise ValueError('HK daily amount missing')
    rows = []
    for raw in raw_rows:
        if not isinstance(raw, list) or len(raw) < 6:
            raise ValueError('HK daily amount malformed')
        date = str(raw[0])
        valid_date(date, current)
        # Verified HSI daily contract: [date, open, close, high, low, HKD amount].
        item = {'date': date, 'amountYi': round(number(raw[5]) / 100_000_000, 8), 'status': 'close'}
        if date == current.date().isoformat():
            if observed.date().isoformat() != date or observed.hour * 60 + observed.minute < 570:
                raise ValueError('HK amount and quote dates do not agree')
            item['asOf'] = observed.strftime('%H:%M')
            item['status'] = 'close' if observed.hour * 60 + observed.minute >= 970 else 'live'
        rows.append(item)
    return validate_hk_rows(rows, current)


def validate_margin_rows(rows, now=None):
    if not isinstance(rows, list) or len(rows) < 20 or len(rows) > 100:
        raise ValueError('margin history incomplete')
    result, previous = [], ''
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError('malformed margin observation')
        date = str(raw.get('date', ''))
        valid_date(date, now)
        value = number(raw.get('balanceYi'))
        if date <= previous or not 100 < value < 1_000_000:
            raise ValueError('invalid margin amount or duplicate dates')
        result.append({'date': date, 'balanceYi': value})
        previous = date
    return result[-60:]


def parse_margin(payload, now=None):
    if not isinstance(payload, dict) or payload.get('success') is not True or payload.get('code') != 0:
        raise ValueError('margin source rejected request')
    raw = payload.get('result', {}).get('data')
    if not isinstance(raw, list):
        raise ValueError('margin source empty')
    rows = []
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError('margin source malformed')
        value = number(row.get('RZRQYE'))
        # RPTA_RZRQ_LSHJ.RZRQYE is CNY yuan, as used by the existing daily card.
        if value <= 10_000_000_000:
            raise ValueError('unexpected RZRQYE yuan amount')
        rows.append({'date': str(row.get('DIM_DATE', ''))[:10], 'balanceYi': round(value / 100_000_000, 8)})
    return validate_margin_rows(sorted(rows, key=lambda r: r['date']), now)


def request_text(url, encoding='utf-8'):
    last = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=8) as response:
                return response.read(5_000_000).decode(encoding, errors='strict')
        except Exception as exc:
            last = exc
            if not attempt:
                time.sleep(.35)
    raise RuntimeError(type(last).__name__ + ': ' + str(last)[:160])


def fetch_quotes(now):
    codes = ','.join((*CAP_CODES, *PE_CODES))
    return parse_tencent(request_text('https://qt.gtimg.cn/q=' + codes, 'gbk'), now)


def fetch_hk_amount(now):
    url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?' + urlencode({'param': 'hkHSI,day,,,60,qfq', '_': int(now.timestamp() * 1000)})
    return parse_hk_amount(json.loads(request_text(url)), now)


def fetch_margin(now):
    params = {'source': 'WEB', 'client': 'WEB', 'pageSize': 60, 'pageNumber': 1,
              'sortTypes': -1, 'reportName': 'RPTA_RZRQ_LSHJ', 'columns': 'DIM_DATE,RZRQYE', 'sortColumns': 'DIM_DATE'}
    return parse_margin(json.loads(request_text('https://datacenter-web.eastmoney.com/api/data/v1/get?' + urlencode(params))), now)


def prior_part(previous, key, now):
    part = previous.get(key) if isinstance(previous, dict) and previous.get('schemaVersion') == 1 else None
    if not isinstance(part, dict):
        return []
    try:
        if key == 'caps':
            return validate_caps(part.get('quotes'), now)
        if key == 'pe':
            result = {}
            for raw in part.get('quotes', []):
                try:
                    row = validate_quote(raw, 'pe', now)
                    if row['code'] not in result or row['quoteTs'] > result[row['code']]['quoteTs']:
                        result[row['code']] = row
                except (ValueError, TypeError, OverflowError, OSError):
                    continue
            return list(result.values())
        return (validate_hk_rows if key == 'hkAmount' else validate_margin_rows)(part.get('series'), now)
    except (ValueError, TypeError, OverflowError, OSError):
        return []


def merge_observations(key, old, incoming):
    if key == 'caps':
        prior = {r['code']: r for r in old}
        return incoming if incoming and all(r['quoteTs'] >= prior.get(r['code'], {}).get('quoteTs', 0) for r in incoming) else old
    if key == 'pe':
        rows = {r['code']: r for r in old}
        for row in incoming:
            if row['quoteTs'] >= rows.get(row['code'], {}).get('quoteTs', 0):
                rows[row['code']] = row
        return [rows[code] for code in PE_CODES if code in rows]
    rows = {r['date']: r for r in old}
    for row in incoming:
        prior = rows.get(row['date'])
        if prior is None or key == 'hkAmount' and (prior['status'] != 'close' and
                (row['status'] == 'close' or row.get('asOf', '') >= prior.get('asOf', ''))):
            rows[row['date']] = row
    return [rows[date] for date in sorted(rows)[-60:]]


def refresh(previous=None, now=None):
    now = as_now(now)
    observed, errors = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fn, now): name for name, fn in
                   [('quotes', fetch_quotes), ('hkAmount', fetch_hk_amount), ('margin', fetch_margin)]}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                value = future.result()
                if name == 'quotes':
                    observed.update(value)
                    for key in ('caps', 'pe'):
                        if not value.get(key):
                            errors[key] = 'source returned no complete valid observations'
                else:
                    observed[name] = value
            except Exception as exc:
                keys = ('caps', 'pe') if name == 'quotes' else (name,)
                for key in keys:
                    errors[key] = (type(exc).__name__ + ': ' + str(exc))[:200]
    if not any(observed.values()):
        raise RuntimeError('All market KPI sources unavailable; existing snapshot retained unchanged')
    result = {'schemaVersion': 1, 'checkedAt': now.isoformat(timespec='seconds'),
              'scope': '市值：沪深A股及创业板/科创板拆分；PE：对应四指数；港股：主板成交额；两融：沪深融资融券余额'}
    for key in ('caps', 'pe', 'hkAmount', 'margin'):
        incoming, old = observed.get(key, []), prior_part(previous, key, now)
        rows = merge_observations(key, old, incoming)
        status = 'ok' if incoming else 'retained' if old else 'unavailable'
        if key == 'pe' and len(incoming) < 4 and incoming:
            status = 'partial'
        part = {'quotes' if key in ('caps', 'pe') else 'series': rows,
                'source': '东方财富' if key == 'margin' else '腾讯财经', 'status': status}
        if errors.get(key):
            part['error'] = errors[key]
        result[key] = part
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        previous = json.loads(args.output.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        previous = None
    try:
        payload = refresh(previous)
    except Exception as exc:
        print(str(exc))
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + '.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(args.output)
    print(json.dumps({'checkedAt': payload['checkedAt'], 'parts': {key: payload[key]['status'] for key in ('caps', 'pe', 'hkAmount', 'margin')}}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
