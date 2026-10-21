#!/usr/bin/env python3
"""60-session Shanghai/Shenzhen 52-week and moving-average breadth.

Point-in-time universes: Eastmoney daily valuation table (includes ST, no BJ).
Prices: Tencent forward-adjusted daily OHLC, with Eastmoney as a whole-symbol
fallback and a 364-calendar-day window. Never splice different price sources.
A stock must have a full 52-week listing history; a touch counts, and a
zero-volume/suspended session does not. All required symbols must be retrieved
before publishing, so an incomplete request never turns missing data into zero.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
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
MA_OUTPUT = ROOT / 'data/market_ma_breadth.json'
MA_BASELINE = ROOT / 'data/market_ma_breadth_baseline.json'
MA_WINDOWS = (20, 60, 120)
TZ = dt.timezone(dt.timedelta(hours=8))
METHOD = ('沪深A股（含ST、不含北交所）；按每个交易日当时的股票名单，'
          '统计上市满52周、当日有成交的股票；前复权日内最高/最低价触及52周滚动窗口（回溯364自然日，含边界日）极值；差值=新高-新低。')
SOURCE = '东方财富每日股票名单 · 腾讯财经/东方财富前复权日线'
MA_METHOD = ('沪深A股（含ST、不含北交所）；按每个交易日当时的股票名单，'
             '以同一批前复权日线计算20/60/120日收盘均线（含当日）；'
             '收盘价严格高于均线计入分子；当日无行情、停牌无成交或该窗口历史不足的股票不计入该窗口分母；占比=高于均线家数/可比家数。')
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
    errors = []
    for host in ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
                 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get'):
        try:
            payload = get_json(host + '?' + urlencode({'param': f'{code},day,,,500,qfq'}), attempts=1)
            return parse_bars(payload, code)
        except Exception as exc:
            errors.append(str(exc))
    # Keep the entire adjusted history from one provider and one retrieval.
    # A failed Tencent request must not be patched with individual raw bars.
    try:
        return fetch_eastmoney_bars(code)
    except Exception as exc:
        errors.append(str(exc))
    raise RuntimeError(f'{code}: all adjusted daily endpoints failed: {errors}')


def fetch_eastmoney_bars(code):
    if not re.fullmatch(r'(?:sh|sz)\d{6}', str(code)):
        raise ValueError('Invalid Eastmoney daily symbol')
    market = 1 if code.startswith('sh') else 0
    start = (dt.datetime.now(TZ).date() - dt.timedelta(days=900)).strftime('%Y%m%d')
    payload = get_json('https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urlencode({
        'secid': f'{market}.{code[2:]}', 'klt': 101, 'fqt': 1,
        'beg': start, 'end': '20500101', 'lmt': 500,
        'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56',
    }), attempts=1)
    item = payload.get('data') or {}
    rows = item.get('klines')
    if (payload.get('rc') != 0 or item.get('code') != code[2:] or
            item.get('market') != market or not isinstance(rows, list) or not rows):
        raise ValueError(f'{code}: invalid Eastmoney adjusted daily response')
    # Same column order as Tencent: date, open, close, high, low, volume.
    if any(not isinstance(row, str) or len(row.split(',')) != 6 for row in rows):
        raise ValueError(f'{code}: malformed Eastmoney adjusted daily bars')
    return parse_bars({'code': 0, 'data': {code: {'qfqday': [row.split(',') for row in rows]}}}, code)[-500:]


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


def require_complete_prices(dates, universes, prices):
    """An unavailable symbol is a failed build, not a zero/absent observation."""
    required = set().union(*(set(universes[date]) for date in dates))
    missing = required - set(prices)
    empty = {code for code in required & set(prices) if not prices[code]}
    if missing or empty:
        raise ValueError(f'Incomplete symbols: {len(missing)} missing, {len(empty)} empty')


def ma_observation(bars, date, window, end=None):
    """Count only tradable, positive-current-price observations with N bars."""
    if end is None:
        end = bisect_right([row['date'] for row in bars], date)
    if not end or bars[end - 1]['date'] != date or end < window:
        return False, False
    current = bars[end - 1]
    if current['volume'] <= 0 or not math.isfinite(current['close']) or current['close'] <= 0:
        return False, False
    closes = [row['close'] for row in bars[end - window:end]]
    if not all(math.isfinite(value) for value in closes):
        raise ValueError(f'{date}: nonfinite adjusted close in {window}-day window')
    # Historical forward-adjusted closes may legitimately be negative.
    mean = math.fsum(closes) / window
    return True, current['close'] > mean


def build_ma_series(dates, universes, prices):
    require_complete_prices(dates, universes, prices)
    bar_dates = {code: [row['date'] for row in bars] for code, bars in prices.items()}
    series = []
    for date in dates:
        totals = {window: [0, 0] for window in MA_WINDOWS}
        for code in universes[date]:
            end = bisect_right(bar_dates[code], date)
            for window in MA_WINDOWS:
                yes, up = ma_observation(prices[code], date, window, end)
                totals[window][0] += int(up)
                totals[window][1] += int(yes)
        windows = {str(window): {'above': above, 'eligible': eligible,
                                'pct': round(100 * above / eligible, 4) if eligible else None}
                   for window, (above, eligible) in totals.items()}
        series.append({'date': date, 'asOf': '15:00', 'status': 'close',
                       'universe': len(universes[date]), 'windows': windows})
    return series[-60:]


def build_ma_baseline(latest, universe, prices, updated):
    require_complete_prices([latest], {latest: universe}, prices)
    stocks = []
    for code in sorted(universe):
        bars = [row for row in prices[code] if row['date'] <= latest]
        if not bars:
            raise ValueError(f'{code}: no completed daily bars through {latest}')
        close = bars[-1]['close']
        if not math.isfinite(close) or close <= 0:
            raise ValueError(f'{code}: invalid latest completed close')
        prior_sums = {}
        for window in MA_WINDOWS:
            closes = [row['close'] for row in bars[-(window - 1):]]
            if not all(math.isfinite(value) for value in closes):
                raise ValueError(f'{code}: nonfinite adjusted close in baseline')
            prior_sums[str(window)] = math.fsum(closes) if len(closes) == window - 1 else None
        stocks.append({'code': code, 'lastDate': bars[-1]['date'], 'close': close,
                       'priorSums': prior_sums})
    return {'schemaVersion': 1, 'windows': list(MA_WINDOWS), 'updatedAt': updated,
            'asOfDate': latest, 'stocks': stocks}


def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Invalid snapshot date')
    return dt.date.fromisoformat(value)


def nonnegative_integer(value):
    return type(value) is int and value >= 0


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_ma_metadata(payload, latest, now):
    if type(payload.get('schemaVersion')) is not int or payload.get('schemaVersion') != 1:
        raise ValueError('Invalid moving-average schemaVersion')
    if payload.get('windows') != list(MA_WINDOWS):
        raise ValueError('Invalid moving-average windows')
    if valid_date(latest) > now.date():
        raise ValueError('Future moving-average asOf date')
    updated = dt.datetime.fromisoformat(str(payload.get('updatedAt', '')).replace('Z', '+00:00'))
    if updated.tzinfo is None or updated > now:
        raise ValueError('Invalid or future moving-average updatedAt')


def validate_ma_history(payload, latest, now=None):
    now = now or dt.datetime.now(TZ)
    validate_ma_metadata(payload, latest, now)
    if not isinstance(payload.get('source'), str) or not payload['source'].strip():
        raise ValueError('Missing moving-average source')
    if not isinstance(payload.get('methodology'), str) or not payload['methodology'].strip():
        raise ValueError('Missing moving-average methodology')
    rows = payload.get('series')
    if not isinstance(rows, list) or len(rows) != 60:
        raise ValueError('Moving-average history requires 60 sessions')
    dates = []
    expected_keys = set(map(str, MA_WINDOWS))
    for row in rows:
        date = row.get('date')
        valid_date(date)
        if date > latest or row.get('asOf') != '15:00' or row.get('status') != 'close':
            raise ValueError('Invalid moving-average close observation')
        dates.append(date)
        universe = row.get('universe')
        windows = row.get('windows')
        if not nonnegative_integer(universe) or not isinstance(windows, dict) or set(windows) != expected_keys:
            raise ValueError('Invalid moving-average universe/windows')
        for window in MA_WINDOWS:
            entry = windows[str(window)]
            if not isinstance(entry, dict):
                raise ValueError('Invalid moving-average window entry')
            above, eligible, pct = entry.get('above'), entry.get('eligible'), entry.get('pct')
            if not nonnegative_integer(above) or not nonnegative_integer(eligible) or not above <= eligible <= universe:
                raise ValueError('Invalid moving-average counts')
            if eligible == 0:
                if pct is not None:
                    raise ValueError('Empty moving-average denominator must have null pct')
            elif not finite_number(pct) or not math.isclose(pct, round(100 * above / eligible, 4), rel_tol=0, abs_tol=.00011):
                raise ValueError('Invalid moving-average percentage')
    if len(set(dates)) != 60 or dates != sorted(dates) or dates[-1] != latest:
        raise ValueError('Moving-average dates must be unique, increasing and current')
    return payload


def validate_ma_baseline(payload, latest, universe, now=None):
    now = now or dt.datetime.now(TZ)
    validate_ma_metadata(payload, latest, now)
    if payload.get('asOfDate') != latest:
        raise ValueError('Moving-average baseline asOf mismatch')
    stocks = payload.get('stocks')
    if not isinstance(stocks, list) or len(stocks) != universe:
        raise ValueError('Moving-average baseline universe mismatch')
    codes = set()
    for row in stocks:
        code = row.get('code')
        if not isinstance(code, str) or len(code) != 8 or code[:2] not in ('sh', 'sz') or not valid_code(code[2:] + '.' + code[:2].upper()) or code in codes:
            raise ValueError('Invalid or duplicate moving-average baseline code')
        codes.add(code)
        last = row.get('lastDate')
        valid_date(last)
        if last > latest or not finite_number(row.get('close')) or row['close'] <= 0:
            raise ValueError('Invalid moving-average baseline completed close')
        sums = row.get('priorSums')
        if not isinstance(sums, dict) or set(sums) != set(map(str, MA_WINDOWS)) or any(value is not None and not finite_number(value) for value in sums.values()):
            raise ValueError('Invalid moving-average baseline priorSums')
    return payload


def complete_cached_snapshots(latest, now=None):
    """Reuse requires both history products and their matching close baselines."""
    if not all(path.exists() for path in (OUTPUT, BASELINE, MA_OUTPUT, MA_BASELINE)):
        return False
    try:
        old = json.loads(OUTPUT.read_text())
        baseline = json.loads(BASELINE.read_text())
        ma = json.loads(MA_OUTPUT.read_text())
        ma_baseline = json.loads(MA_BASELINE.read_text())
        previous = old.get('series') or []
        validate_ma_history(ma, latest, now)
        validate_ma_baseline(ma_baseline, latest, ma['series'][-1]['universe'], now)
        return (len(previous) == 60 and previous[-1].get('date') == latest and
                baseline.get('asOfDate') == latest and bool(baseline.get('validThrough')) and
                bool(baseline.get('stocks')))
    except (OSError, TypeError, ValueError, IndexError, AttributeError, KeyError, OverflowError):
        return False


def parallel_map(items, fn, workers=6, label='fetch', attempts=3):
    result, errors = {}, {}
    pending = list(items)
    for attempt in range(max(1, min(attempts, 3))):
        if attempt:
            # A short bounded cooldown; retry only missing symbols, preserving
            # successful same-run histories in their original adjustment basis.
            time.sleep((5, 15)[attempt - 1])
            print(f'{label}: retry {attempt}, {len(pending)} missing items', flush=True)
        errors = {}
        total = len(pending)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(fn, item): item for item in pending}
            for number, future in enumerate(concurrent.futures.as_completed(futures), 1):
                item = futures[future]
                try:
                    result[item] = future.result()
                except Exception as exc:
                    errors[item] = str(exc)
                if number % 200 == 0 or number == total:
                    print(f'{label}: {number}/{total}; errors={len(errors)}', flush=True)
        if not errors:
            return result
        pending = list(errors)
    if errors:
        raise RuntimeError(f'{label} incomplete: {len(errors)} failures; {list(errors.items())[:8]}')
    return result


def refresh_history(cache_dir, workers=6, force=False):
    now = dt.datetime.now(TZ)
    index_bars = fetch_bars('sh000001')
    available_dates = [row['date'] for row in index_bars if row['volume'] > 0 and row['date'] <= now.date().isoformat() and
                       (row['date'] < now.date().isoformat() or now.hour >= 15)]
    dates = available_dates[-60:]
    if len(dates) != 60:
        raise RuntimeError('Need 60 completed trading sessions')
    latest = dates[-1]
    if not force and complete_cached_snapshots(latest, now):
        print(f'Complete {latest} close snapshots already available; retained.', flush=True)
        return
    if latest == now.date().isoformat():
        try:
            cached(cache_dir / ('universe-' + latest + '.json'), lambda: fetch_universe(latest))
        except Exception as exc:
            # The daily constituent table is often released later than the
            # closing quote. Repair yesterday now, never label it as today.
            dates = available_dates[:-1][-60:]
            if len(dates) != 60:
                raise RuntimeError('Need 60 published sessions before current universe is released') from exc
            latest = dates[-1]
            print(f'Today constituent table unavailable; repairing through {latest}: {exc}', flush=True)
            if not force and complete_cached_snapshots(latest, now):
                return
    print(f'Building {dates[0]} → {latest}', flush=True)
    universes = parallel_map(dates, lambda date: cached(cache_dir / ('universe-' + date + '.json'),
                                                      lambda: fetch_universe(date)), workers, 'universes')
    symbols = sorted(set().union(*(set(value) for value in universes.values())))
    # All histories use the same adjustment vintage; reuse only within this
    # completed-session build, never merge differently adjusted raw bars.
    prices = parallel_map(symbols, lambda code: cached(cache_dir / latest / (code + '.json'),
                                                     lambda: fetch_bars(code)), workers, 'daily bars')
    # Daily APIs can already include a live/future bar. Neither historical
    # series nor next-session comparison prices may use an uncompleted bar.
    prices = {code: [row for row in bars if row['date'] <= latest] for code, bars in prices.items()}
    require_complete_prices(dates, universes, prices)
    series = build_series(dates, universes, prices)
    ma_series = build_ma_series(dates, universes, prices)
    updated = now.isoformat(timespec='seconds')
    payload = {'schemaVersion': 1, 'updatedAt': updated, 'methodology': METHOD,
               'source': SOURCE, 'series': series}
    ma_payload = {'schemaVersion': 1, 'windows': list(MA_WINDOWS), 'updatedAt': updated,
                  'source': SOURCE, 'methodology': MA_METHOD, 'series': ma_series}
    ma_baseline = build_ma_baseline(latest, universes[latest], prices, updated)
    validate_ma_history(ma_payload, latest, now)
    validate_ma_baseline(ma_baseline, latest, ma_series[-1]['universe'], now)
    start = (dt.date.fromisoformat(latest) - dt.timedelta(days=364)).isoformat()
    through = (dt.date.fromisoformat(latest) + dt.timedelta(days=21)).isoformat()
    baseline = {'schemaVersion': 1, 'updatedAt': updated, 'asOfDate': latest, 'validThrough': through,
                'stocks': [{'code': code, 'firstDate': prices[code][0]['date'],
                            'lastDate': prices[code][-1]['date'], 'close': prices[code][-1]['close'],
                            'highs': extrema_queue(prices[code], 'high', start, through),
                            'lows': extrema_queue(prices[code], 'low', start, through)}
                           for code in sorted(universes[latest])]}
    # No output writes above: publish only after both products validate.
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    BASELINE.write_text(json.dumps(baseline, ensure_ascii=False, separators=(',', ':')) + '\n')
    MA_OUTPUT.write_text(json.dumps(ma_payload, ensure_ascii=False, indent=2) + '\n')
    MA_BASELINE.write_text(json.dumps(ma_baseline, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'Published {len(series)} sessions; last={series[-1]}', flush=True)
    print(f'Moving-average breadth: last={ma_series[-1]}', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, default=Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'high-low-52w-cache')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--force', action='store_true', help='Rebuild even on a non-trading day')
    args = parser.parse_args()
    refresh_history(args.cache_dir, max(1, min(args.workers, 10)), args.force)


if __name__ == '__main__':
    main()

