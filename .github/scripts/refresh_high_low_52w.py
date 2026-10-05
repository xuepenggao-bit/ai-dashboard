#!/usr/bin/env python3
"""60-session Shanghai/Shenzhen 52-calendar-week high/low breadth.

Point-in-time universes: Eastmoney daily valuation table (includes ST, no BJ).
Prices: Tencent forward-adjusted daily OHLC, with a 364-calendar-day window.
A stock must have a full 52-week listing history; a touch counts, and a
zero-volume/suspended session does not. All required symbols must be retrieved
before publishing, so an incomplete request never turns missing data into zero.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/market_high_low_52w.json'
BASELINE = ROOT / 'data/market_high_low_52w_baseline.json'
TZ = dt.timezone(dt.timedelta(hours=8))
METHOD = ('沪深A股（含ST、不含北交所）；按每个交易日当时的股票名单，'
          '统计上市满52周、当日有成交的股票；前复权日内最高/最低价触及52周滚动窗口（回溯364自然日，含边界日）极值；差值=新高-新低。')
SOURCE = '东方财富每日股票名单 · 腾讯财经前复权日线/实时行情'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'


def get_json(url, attempts=3):
    error = None
    for attempt in range(attempts):
        try:
            req = Request(url, headers={'User-Agent': UA, 'Referer': 'https://gu.qq.com/'})
            with urlopen(req, timeout=25) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(.6 * (attempt + 1))
    raise RuntimeError(f'{url.split("?")[0]}: {error}')


def valid_code(secucode):
    return bool(re.fullmatch(r'(?:60\d{4}|68\d{4})\.SH|(?:00\d{4}|30\d{4})\.SZ', str(secucode)))


def cached(path, loader):
    if path.exists():
        return json.loads(path.read_text())
    result = loader()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return result


def fetch_universe(date):
    payload = get_json('https://datacenter-web.eastmoney.com/api/data/v1/get?' + urlencode({
        'reportName': 'RPT_VALUEANALYSIS_DET',
        'columns': 'SECUCODE,SECURITY_NAME_ABBR,TRADE_DATE',
        'pageSize': 10000, 'pageNumber': 1, 'sortColumns': 'SECURITY_CODE',
        'sortTypes': '1', 'filter': f"(TRADE_DATE='{date}')", 'source': 'WEB', 'client': 'WEB',
    }))
    result = payload.get('result') or {}
    rows = result.get('data') or []
    if not payload.get('success') or len(rows) != result.get('count'):
        raise RuntimeError(f'{date}: incomplete daily universe')
    symbols = {}
    for row in rows:
        code = row.get('SECUCODE', '')
        if not valid_code(code):
            continue
        symbol = code[-2:].lower() + code[:6]
        if symbol in symbols:
            raise RuntimeError(f'{date}: duplicate symbol {symbol}')
        if str(row.get('TRADE_DATE', ''))[:10] != date:
            raise RuntimeError(f'{date}: mismatched source date')
        symbols[symbol] = row.get('SECURITY_NAME_ABBR', '')
    if len(symbols) < 4000:
        raise RuntimeError(f'{date}: suspicious universe size {len(symbols)}')
    return symbols


def parse_bars(payload, code):
    item = (payload.get('data') or {}).get(code) or {}
    raw = item.get('qfqday') or item.get('day')
    if payload.get('code') != 0 or not isinstance(raw, list) or not raw:
        raise ValueError(f'{code}: no adjusted daily bars')
    bars = []
    for row in raw:
        try:
            date = dt.date.fromisoformat(row[0]).isoformat()
            close, high, low, volume = map(float, (row[2], row[3], row[4], row[5]))
            if not all(math.isfinite(n) for n in (close, high, low, volume)):
                raise ValueError('nonfinite price')
            if high < low or volume < 0:
                raise ValueError('invalid OHLC')
            bars.append({'date': date, 'close': close, 'high': high, 'low': low, 'volume': volume})
        except (TypeError, ValueError, IndexError) as exc:
            raise ValueError(f'{code}: malformed daily bar') from exc
    if len({row['date'] for row in bars}) != len(bars):
        raise ValueError(f'{code}: duplicate dates')
    return sorted(bars, key=lambda row: row['date'])


def fetch_bars(code):
    error = None
    for host in ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
                 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get'):
        try:
            payload = get_json(host + '?' + urlencode({'param': f'{code},day,,,500,qfq'}), attempts=1)
            return parse_bars(payload, code)
        except Exception as exc:
            error = exc
    raise RuntimeError(f'{code}: both Tencent daily endpoints failed: {error}')


def extrema_queue(bars, key, start, through=None):
    queue = []
    for row in bars:
        if row['date'] < start:
            continue
        while queue and (queue[-1][1] <= row[key] if key == 'high' else queue[-1][1] >= row[key]):
            queue.pop()
        queue.append([row['date'], row[key]])
    # Only the queue prefix can expire before the next baseline refresh. Keep
    # the first node beyond that cutoff too; later nodes cannot be queried.
    if through:
        cutoff = (dt.date.fromisoformat(through) - dt.timedelta(days=364)).isoformat()
        for i, node in enumerate(queue):
            if node[0] > cutoff:
                return queue[:i + 1]
    return queue


def classify(bars, date):
    """Return (eligible, touches_high, touches_low); 52 natural, not 250 sessions."""
    start = (dt.date.fromisoformat(date) - dt.timedelta(days=364)).isoformat()
    if not bars or bars[0]['date'] > start:
        return False, False, False
    window = [row for row in bars if start <= row['date'] <= date]
    today = next((row for row in reversed(window) if row['date'] == date), None)
    if today is None or today['volume'] <= 0:
        return True, False, False
    # Negative historical forward-adjusted prices can be genuine after large
    # dividends; do not silently discard those observations.
    high = max(row['high'] for row in window)
    low = min(row['low'] for row in window)
    return True, today['high'] >= high - 1e-7, today['low'] <= low + 1e-7


def build_series(dates, universes, prices):
    missing = set().union(*(set(universes[date]) for date in dates)) - set(prices)
    if missing:
        raise ValueError(f'Incomplete symbols: {len(missing)}')
    series = []
    for date in dates:
        high = low = eligible = 0
        for code in universes[date]:
            yes, up, down = classify(prices[code], date)
            eligible += int(yes)
            high += int(up)
            low += int(down)
        if eligible < 4000:
            raise ValueError(f'{date}: insufficient 52-week history ({eligible})')
        series.append({'date': date, 'high': high, 'low': low, 'eligible': eligible,
                       'universe': len(universes[date]), 'asOf': '15:00', 'status': 'close'})
    return series[-60:]


def parallel_map(items, fn, workers=6, label='fetch'):
    result, errors = {}, {}
    total = len(items)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, item): item for item in items}
        for number, future in enumerate(concurrent.futures.as_completed(futures), 1):
            item = futures[future]
            try:
                result[item] = future.result()
            except Exception as exc:
                errors[item] = str(exc)
            if number % 200 == 0 or number == total:
                print(f'{label}: {number}/{total}; errors={len(errors)}', flush=True)
    if errors:
        raise RuntimeError(f'{label} incomplete: {len(errors)} failures; {list(errors.items())[:8]}')
    return result


def refresh_history(cache_dir, workers=6, force=False):
    now = dt.datetime.now(TZ)
    index_bars = fetch_bars('sh000001')
    dates = [row['date'] for row in index_bars if row['volume'] > 0 and
             (row['date'] < now.date().isoformat() or now.hour >= 15)][-60:]
    if len(dates) != 60:
        raise RuntimeError('Need 60 completed trading sessions')
    latest = dates[-1]
    if not force and latest < now.date().isoformat() and OUTPUT.exists() and BASELINE.exists():
        old = json.loads(OUTPUT.read_text())
        baseline = json.loads(BASELINE.read_text())
        previous = old.get('series') or []
        if len(previous) == 60 and previous[-1].get('date') == latest and baseline.get('asOfDate') == latest and baseline.get('validThrough'):
            print(f'Exchange closed; complete {latest} snapshot retained.', flush=True)
            return
    print(f'Building {dates[0]} → {latest}', flush=True)
    universes = parallel_map(dates, lambda date: cached(cache_dir / ('universe-' + date + '.json'),
                                                      lambda: fetch_universe(date)), workers, 'universes')
    symbols = sorted(set().union(*(set(value) for value in universes.values())))
    # All histories use the same adjustment vintage; reuse only within this
    # completed-session build, never merge differently adjusted raw bars.
    prices = parallel_map(symbols, lambda code: cached(cache_dir / latest / (code + '.json'),
                                                     lambda: fetch_bars(code)), workers, 'daily bars')
    series = build_series(dates, universes, prices)
    updated = now.isoformat(timespec='seconds')
    payload = {'schemaVersion': 1, 'updatedAt': updated, 'methodology': METHOD,
               'source': SOURCE, 'series': series}
    start = (dt.date.fromisoformat(latest) - dt.timedelta(days=364)).isoformat()
    through = (dt.date.fromisoformat(latest) + dt.timedelta(days=21)).isoformat()
    baseline = {'schemaVersion': 1, 'updatedAt': updated, 'asOfDate': latest, 'validThrough': through,
                'stocks': [{'code': code, 'firstDate': prices[code][0]['date'],
                            'lastDate': prices[code][-1]['date'], 'close': prices[code][-1]['close'],
                            'highs': extrema_queue(prices[code], 'high', start, through),
                            'lows': extrema_queue(prices[code], 'low', start, through)}
                           for code in sorted(universes[latest])]}
    # No writes above: only publish after both universe and all histories pass.
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    BASELINE.write_text(json.dumps(baseline, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Published {len(series)} sessions; last={series[-1]}', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, default=Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'high-low-52w-cache')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--force', action='store_true', help='Rebuild even on a non-trading day')
    args = parser.parse_args()
    refresh_history(args.cache_dir, max(1, min(args.workers, 10)), args.force)


if __name__ == '__main__':
    main()
