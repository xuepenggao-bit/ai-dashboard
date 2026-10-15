#!/usr/bin/env python3
"""Completed-session CSI All Share volatility and distance from 60-session high.

The intraday UI can recompute from ``bars`` without rounding the underlying
prices. A failed or stale download never replaces an existing valid snapshot.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re
import statistics
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/market_risk.json'
TZ = dt.timezone(dt.timedelta(hours=8))
INDEX = {'code': '000985', 'name': '中证全指'}
SYMBOL = 'sh000985'
TENCENT_HOSTS = (
    'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
)
EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
EM_QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
METHODOLOGY = (
    '中证全指未复权日线；20日实际波动率为最近20个日对数收益的样本标准差（21个收盘价，ddof=1）'
    '乘√252并以百分比表示；60日高点回撤=当前收盘价/最近60个交易日最高价（含当日）−1。'
    '这是距离滚动高点的回撤，不是区间最大回撤；仅已收盘交易日纳入日频历史，盘中预估由前端另标。'
)


def local_now():
    return dt.datetime.now(TZ)


def finite_number(value, *, positive=False):
    if isinstance(value, bool):
        raise ValueError('boolean is not a numeric observation')
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError('nonfinite or nonpositive observation')
    return result


def parse_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('invalid/missing ISO date')
    date = dt.date.fromisoformat(value)
    if date.weekday() >= 5:
        raise ValueError('non-trading weekend date')
    return date


def validate_bars(rows, now=None):
    """Require source order and valid OHLC; never sort away a corrupt response."""
    now = (now or local_now()).astimezone(TZ)
    if not isinstance(rows, list) or not rows:
        raise ValueError('empty daily bars')
    result, previous = [], None
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError('malformed daily bar')
        date = parse_date(raw.get('date'))
        if date > now.date():
            raise ValueError('future daily bar')
        if previous is not None and date <= previous:
            raise ValueError('duplicate or non-increasing dates')
        previous = date
        close, high, low = [finite_number(raw.get(key), positive=True) for key in ('close', 'high', 'low')]
        volume = finite_number(raw.get('volume'), positive=True)
        if not low <= close <= high:
            raise ValueError('invalid high/low/close relationship')
        if 'open' in raw:
            open_price = finite_number(raw['open'], positive=True)
            if not low <= open_price <= high:
                raise ValueError('invalid high/low/open relationship')
        result.append({'date': date.isoformat(), 'close': close, 'high': high, 'low': low, 'volume': volume})
    return result


def completed_bars(rows, now=None, quote_time=None):
    now = (now or local_now()).astimezone(TZ)
    rows = validate_bars(rows, now)
    today_closed = now.time() >= dt.time(15)
    # A stale quote from before the closing auction cannot certify today's
    # daily candle, even if this script happens to run after 15:00.
    if quote_time is not None:
        quote_time = quote_time.astimezone(TZ)
        if quote_time > now + dt.timedelta(minutes=2):
            raise ValueError('future quote timestamp')
        today_closed = today_closed and quote_time.date() == now.date() and quote_time.time() >= dt.time(15)
    return [row for row in rows if row['date'] < now.date().isoformat() or today_closed]


def parse_tencent(payload, code=SYMBOL, now=None):
    if not isinstance(payload, dict) or type(payload.get('code')) is not int or payload.get('code') != 0:
        raise ValueError('Tencent request failed')
    item = (payload.get('data') or {}).get(code)
    if not isinstance(item, dict) or not isinstance(item.get('day'), list) or not item['day']:
        raise ValueError('wrong code or no unadjusted Tencent daily bars')
    # Explicitly reject adjusted-only responses for this index metric.
    quote = (item.get('qt') or {}).get(code)
    stamp = None
    if quote is not None:
        if not isinstance(quote, list) or len(quote) <= 34 or str(quote[2]) != code[2:]:
            raise ValueError('mismatched Tencent quote code')
        if not re.fullmatch(r'\d{14}', str(quote[30])):
            raise ValueError('invalid Tencent quote timestamp')
        stamp = dt.datetime.strptime(str(quote[30]), '%Y%m%d%H%M%S').replace(tzinfo=TZ)
    rows = []
    for raw in item['day']:
        if not isinstance(raw, list) or len(raw) < 6:
            raise ValueError('malformed Tencent OHLC row')
        rows.append(dict(zip(('date', 'open', 'close', 'high', 'low', 'volume'), raw[:6])))
    rows = validate_bars(rows, now)
    if rows[-1]['date'] == (now or local_now()).astimezone(TZ).date().isoformat() and stamp is None:
        # Historical rows remain useful, but an undated response cannot
        # turn today's provisional candle into a completed close.
        stamp = dt.datetime.combine((now or local_now()).astimezone(TZ).date(), dt.time(0), TZ)
    if quote is not None and stamp.date().isoformat() == rows[-1]['date']:
        for key, position in (('close', 3), ('high', 33), ('low', 34)):
            value = finite_number(quote[position], positive=True)
            if not math.isclose(value, rows[-1][key], rel_tol=0, abs_tol=.011):
                raise ValueError('quote and latest daily bar disagree')
    return completed_bars(rows, now, stamp)


def parse_eastmoney(payload, code=SYMBOL, now=None, quote=None):
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict) or str(data.get('code')) != code[2:] or type(data.get('market')) is not int or data.get('market') != 1:
        raise ValueError('wrong Eastmoney index code or market')
    raw_rows = data.get('klines')
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ValueError('missing Eastmoney daily bars')
    rows = []
    for raw in raw_rows:
        fields = raw.split(',') if isinstance(raw, str) else []
        if len(fields) < 6:
            raise ValueError('malformed Eastmoney OHLC row')
        rows.append(dict(zip(('date', 'open', 'close', 'high', 'low', 'volume'), fields[:6])))
    rows = validate_bars(rows, now)
    stamp = None
    current_date = (now or local_now()).astimezone(TZ).date()
    if rows[-1]['date'] == current_date.isoformat():
        q = quote.get('data') if isinstance(quote, dict) else None
        if not isinstance(q, dict) or str(q.get('f57')) != code[2:]:
            raise ValueError('missing Eastmoney timestamp for today')
        stamp = dt.datetime.fromtimestamp(finite_number(q.get('f86'), positive=True), TZ)
        decimals = q.get('f59')
        if isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 6:
            raise ValueError('invalid quote decimal precision')
        for key, field in (('close', 'f43'), ('high', 'f44'), ('low', 'f45')):
            value = finite_number(q.get(field), positive=True) / 10 ** decimals
            if not math.isclose(value, rows[-1][key], rel_tol=0, abs_tol=.011):
                raise ValueError('Eastmoney quote and daily bar disagree')
    return completed_bars(rows, now, stamp)


def get_json(url, attempts=2):
    error = None
    for attempt in range(attempts):
        try:
            headers = {'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' if 'eastmoney' in url else 'https://gu.qq.com/'}
            with urlopen(Request(url, headers=headers), timeout=20) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(.5)
    raise RuntimeError(f'{url.split("?")[0]}: {error}')


def validate_calendar(bars, calendar):
    """A separate Shanghai benchmark certifies holidays and missing sessions."""
    if not bars or not calendar:
        raise ValueError('missing trading calendar')
    start, end = bars[0]['date'], bars[-1]['date']
    if start < calendar[0]['date'] or end > calendar[-1]['date']:
        raise ValueError('calendar does not cover source bars')
    expected = [row['date'] for row in calendar if start <= row['date'] <= end]
    if [row['date'] for row in bars] != expected:
        raise ValueError('missing or non-trading source date')
    if end != calendar[-1]['date']:
        raise ValueError('stale source missing latest completed session')


def fetch_bars(now=None, code=SYMBOL, calendar=None):
    now = (now or local_now()).astimezone(TZ)
    errors = []
    for host in TENCENT_HOSTS:
        url = host + '?' + urlencode({'param': f'{code},day,,,200,'})
        try:
            bars = parse_tencent(get_json(url), code, now)
            if calendar is not None:
                validate_calendar(bars, calendar)
            return bars, '腾讯财经未复权日线', url
        except Exception as exc:
            errors.append(f'{host}: {exc}')
    url = EM_KLINE + '?' + urlencode({
        'secid': f'1.{code[2:]}', 'klt': 101, 'fqt': 0,
        # Do not ask for an unbounded history: some providers ignore lmt.
        'beg': (now.date() - dt.timedelta(days=500)).strftime('%Y%m%d'),
        'end': now.strftime('%Y%m%d'), 'lmt': 200,
        'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56',
    })
    try:
        raw = get_json(url)
        latest = (((raw.get('data') or {}).get('klines') or [''])[-1]).split(',')[0]
        quote = None
        if latest == now.date().isoformat():
            quote = get_json(EM_QUOTE + '?' + urlencode({'secid': f'1.{code[2:]}', 'fields': 'f43,f44,f45,f57,f58,f59,f86'}))
        bars = parse_eastmoney(raw, code, now, quote)[-200:]
        if calendar is not None:
            validate_calendar(bars, calendar)
        return bars, '东方财富未复权日线', url
    except Exception as exc:
        errors.append(f'{EM_KLINE}: {exc}')
    raise RuntimeError('All index daily sources failed: ' + '; '.join(errors))


def rv20(closes):
    if len(closes) != 21:
        raise ValueError('20 daily returns require exactly 21 closes')
    values = [finite_number(value, positive=True) for value in closes]
    returns = [math.log(values[i] / values[i - 1]) for i in range(1, 21)]
    return statistics.stdev(returns) * math.sqrt(252) * 100


def observation(bars, position):
    if position < 59:
        raise ValueError('60-session high requires 60 bars')
    current = bars[position]
    peak = max(row['high'] for row in bars[position - 59:position + 1])
    return {'date': current['date'], 'asOf': '15:00', 'status': 'close',
            'close': round(current['close'], 4),
            'rv20': round(rv20([row['close'] for row in bars[position - 20:position + 1]]), 4),
            'peak60': round(peak, 4),
            'drawdown60': round(min(0.0, (current['close'] / peak - 1) * 100), 4)}


def build_payload(bars, now=None, source='腾讯财经未复权日线', source_url=None):
    now = (now or local_now()).astimezone(TZ)
    bars = completed_bars(bars, now)
    if len(bars) < 119:
        raise ValueError('insufficient bars: 60 observations require at least 119 closed sessions')
    bars = bars[-200:]
    payload = {'schemaVersion': 1, 'updatedAt': now.isoformat(timespec='seconds'), 'index': dict(INDEX),
               'source': source, 'methodology': METHODOLOGY,
               'series': [observation(bars, i) for i in range(len(bars) - 60, len(bars))],
               'bars': bars}
    if source_url:
        payload['sourceUrl'] = source_url
    return payload


def validate_payload(payload, now=None):
    now = (now or local_now()).astimezone(TZ)
    if not isinstance(payload, dict) or type(payload.get('schemaVersion')) is not int or payload['schemaVersion'] != 1:
        raise ValueError('invalid risk schema')
    if payload.get('index') != INDEX or not payload.get('source') or not payload.get('methodology'):
        raise ValueError('wrong index or missing methodology')
    updated = dt.datetime.fromisoformat(payload.get('updatedAt', ''))
    if updated.tzinfo is None or updated > now + dt.timedelta(minutes=2):
        raise ValueError('invalid/future update timestamp')
    bars = validate_bars(payload.get('bars'), now)
    if len(bars) < 119 or len(bars) > 200 or completed_bars(bars, now) != bars:
        raise ValueError('insufficient or unclosed stored bars')
    # A payload timestamp cannot claim that a bar was already closed before
    # that date's closing auction.
    if completed_bars(bars, updated) != bars:
        raise ValueError('bar not yet closed at snapshot timestamp')
    expected = [observation(bars, i) for i in range(len(bars) - 60, len(bars))]
    series = payload.get('series')
    if not isinstance(series, list) or len(series) != 60:
        raise ValueError('invalid risk history length')
    for actual, wanted in zip(series, expected):
        if not isinstance(actual, dict):
            raise ValueError('malformed risk observation')
        for key in ('date', 'asOf', 'status'):
            if actual.get(key) != wanted[key]:
                raise ValueError('risk history date/status mismatch')
        for key in ('close', 'rv20', 'peak60', 'drawdown60'):
            number = finite_number(actual.get(key))
            if not math.isclose(number, wanted[key], abs_tol=.000051, rel_tol=0):
                raise ValueError('risk metric does not tie to stored raw bars')
    return payload


def refresh(output=OUTPUT, now=None):
    now = (now or local_now()).astimezone(TZ)
    output = Path(output)
    cached = None
    if output.exists():
        try:
            cached = validate_payload(json.loads(output.read_text()), now)
        except (ValueError, TypeError, KeyError):
            # A corrupt cache is not useful, but is still left untouched if
            # fetching fails; it never becomes a fabricated zero snapshot.
            pass
    try:
        calendar, _, _ = fetch_bars(now, 'sh000001')
        bars, source, url = fetch_bars(now, SYMBOL, calendar)
        payload = validate_payload(build_payload(bars, now, source, url), now)
        if cached and payload['series'][-1]['date'] < cached['series'][-1]['date']:
            raise ValueError('refuse history regression')
        output.parent.mkdir(parents=True, exist_ok=True)
        # Atomic publication prevents a reader seeing half of the JSON file.
        temporary = output.with_suffix(output.suffix + '.tmp')
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        temporary.replace(output)
        return payload
    except Exception:
        if cached:
            print('Risk refresh failed; keeping the last valid snapshot.', file=sys.stderr)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args(argv)
    try:
        payload = refresh(args.output)
    except Exception as exc:
        print(f'Risk refresh failed: {exc}', file=sys.stderr)
        return 1
    last = payload['series'][-1]
    print(f"Saved {len(payload['series'])} closed sessions through {last['date']}: rv20={last['rv20']:.4f}%, drawdown60={last['drawdown60']:.4f}%")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
