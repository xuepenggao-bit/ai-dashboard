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
import shutil
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/market_high_low_52w.json'
BASELINE = ROOT / 'data/market_high_low_52w_baseline.json'
MA_OUTPUT = ROOT / 'data/market_ma_breadth.json'
MA_BASELINE = ROOT / 'data/market_ma_breadth_baseline.json'
QUALITY_OUTPUT = ROOT / 'data/market_quality.json'
QUALITY_BASELINE = ROOT / 'data/market_quality_baseline.json'
MA_WINDOWS = (20, 60, 120)
TZ = dt.timezone(dt.timedelta(hours=8))
METHOD = ('沪深A股（含ST、不含北交所）；按每个交易日当时的股票名单，'
          '统计上市满52周、当日有成交的股票；前复权日内最高/最低价触及52周滚动窗口（回溯364自然日，含边界日）极值；差值=新高-新低。')
SOURCE = '东方财富每日股票名单 · 腾讯财经/东方财富前复权日线'
MA_METHOD = ('沪深A股（含ST、不含北交所）；按每个交易日当时的股票名单，'
             '以同一批前复权日线计算20/60/120日收盘均线（含当日）；'
             '收盘价严格高于均线计入分子；当日无行情、停牌无成交或该窗口历史不足的股票不计入该窗口分母；占比=高于均线家数/可比家数。')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
_REFRESH_DEADLINE = None
_DAILY_SOURCE_HEALTH = {}
_DAILY_SOURCE_LOCK = threading.Lock()


def check_deadline():
    if _REFRESH_DEADLINE is not None and time.monotonic() >= _REFRESH_DEADLINE:
        raise RuntimeError('Collection time budget reached; completed symbol caches retained for the next run')


def get_json(url, attempts=3):
    error = None
    for attempt in range(attempts):
        check_deadline()
        try:
            req = Request(url, headers={'User-Agent': UA, 'Referer': 'https://gu.qq.com/'})
            with urlopen(req, timeout=12) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(.6 * (attempt + 1))
    raise RuntimeError(f'{url.split("?")[0]}: {error}')


def valid_code(secucode):
    return bool(re.fullmatch(r'(?:60\d{4}|68\d{4})\.SH|(?:00\d{4}|30\d{4})\.SZ', str(secucode)))


def cached_bars(cache_dir, latest, code, loader):
    """Resume whole-symbol histories only within the same completed-session build.

    A cache file contains one provider's full adjusted series, never a patchwork
    of bars collected on different days or from different price sources.
    """
    path = cache_dir / latest / (code + '.json')
    stored = read_json(path)
    if (isinstance(stored, dict) and stored.get('schemaVersion') == 1 and
            stored.get('asOfDate') == latest and stored.get('code') == code):
        try:
            return validate_cached_bars(stored.get('bars'), latest)
        except (ValueError, TypeError, KeyError):
            pass
    result = validate_cached_bars([row for row in loader() if row['date'] <= latest], latest)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'schemaVersion': 1, 'asOfDate': latest, 'code': code,
                                     'bars': result}, ensure_ascii=False, separators=(',', ':')))
    temporary.replace(path)
    return result


def validate_cached_bars(rows, latest):
    if not isinstance(rows, list) or not rows:
        raise ValueError('Cached daily series is empty')
    previous = ''
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Invalid cached daily bar')
        date = row.get('date')
        if not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date or not previous < date <= latest:
            raise ValueError('Cached daily dates are unordered or outside the completed session')
        values = [row.get(key) for key in ('close', 'high', 'low', 'volume')]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            raise ValueError('Invalid cached daily price')
        if row['high'] < row['low'] or row['volume'] < 0:
            raise ValueError('Invalid cached daily OHLC')
        previous = date
    return rows


def daily_source_ready(host):
    with _DAILY_SOURCE_LOCK:
        return _DAILY_SOURCE_HEALTH.get(host, {}).get('until', 0) <= time.monotonic()


def daily_source_result(host, success):
    with _DAILY_SOURCE_LOCK:
        if success:
            _DAILY_SOURCE_HEALTH.pop(host, None)
        else:
            state = _DAILY_SOURCE_HEALTH.setdefault(host, {'failures': 0, 'until': 0})
            state['failures'] += 1
            if state['failures'] >= 8:
                state['until'] = time.monotonic() + 30


def prune_dated_history_caches(cache_dir, keep=3, now=None):
    """Bound this tool's dated history cache without touching roster files.

    Future dates, symlinks and all non-date entries are outside cleanup scope.
    The current Beijing date is always retained if its directory exists.
    """
    today = (now or dt.datetime.now(TZ)).date().isoformat()
    try:
        candidates = []
        for path in cache_dir.iterdir():
            if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', path.name):
                continue
            try:
                date = dt.date.fromisoformat(path.name).isoformat()
            except ValueError:
                continue
            if date <= today:
                candidates.append(path)
        dated = sorted(candidates, key=lambda path: path.name, reverse=True)
        for path in dated[max(1, keep):]:
            if path.name != today:
                shutil.rmtree(path)
    except OSError as exc:
        # Cleanup failure must not invalidate verified output or mask the
        # original collection error; the next scheduled run can retry it.
        print(f'Dated history cache cleanup deferred: {exc}', flush=True)


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


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return None


def universe_reference(date, cache_dir=None):
    """Prefer a separately calibrated same-day roster, else a recent full scope.

    result.count describes how many rows have been released, not how many
    securities should exist. The daily table can be internally consistent but
    still incomplete shortly after 15:00, so count==len(data) is insufficient.
    """
    target = dt.date.fromisoformat(date)
    candidates = []

    def add(as_of, codes=None, count=None, exact=False):
        try:
            age = (target - dt.date.fromisoformat(as_of)).days
        except (ValueError, TypeError):
            return
        codes = set(codes) if codes is not None else None
        count = len(codes) if codes is not None else count
        if not isinstance(count, int) or count < 4000 or not 0 <= age <= 21:
            return
        if age == 0 and not exact:
            return  # Never use this product's own same-day partial roster as proof.
        if codes is not None and any(not valid_code(code[2:] + '.' + code[:2].upper()) for code in codes):
            return
        candidates.append({'date': as_of, 'codes': codes, 'count': count, 'exact': exact})

    quality, quality_history = read_json(QUALITY_BASELINE), read_json(QUALITY_OUTPUT)
    if isinstance(quality, dict) and isinstance(quality_history, dict):
        stocks, rows = quality.get('stocks'), quality_history.get('series')
        if isinstance(stocks, list) and isinstance(rows, list) and rows:
            final = rows[-1]
            codes = [row.get('code') for row in stocks if isinstance(row, dict)]
            if (quality.get('schemaVersion') == 1 and final.get('date') == quality.get('asOfDate') and
                    final.get('status') == 'close' and not final.get('provisional') and
                    final.get('universeCount') == len(stocks) and len(set(codes)) == len(stocks) and
                    all(isinstance(code, str) and len(code) == 8 for code in codes)):
                add(quality['asOfDate'], codes, exact=quality['asOfDate'] == date)

    baseline, history = read_json(BASELINE), read_json(OUTPUT)
    if isinstance(history, dict) and isinstance(history.get('series'), list):
        for row in history['series']:
            if isinstance(row, dict) and row.get('status') == 'close':
                add(row.get('date'), count=row.get('universe'))
    if isinstance(baseline, dict) and isinstance(baseline.get('stocks'), list):
        codes = [row.get('code') for row in baseline['stocks'] if isinstance(row, dict)]
        if all(isinstance(code, str) and len(code) == 8 for code in codes):
            add(baseline.get('asOfDate'), codes)
    if cache_dir is not None:
        # Inspect only earlier recent rosters; the target cache may be the
        # incomplete one being repaired and must never validate itself.
        for path in sorted(cache_dir.glob('universe-*.json'), reverse=True):
            as_of = path.stem.removeprefix('universe-')
            if as_of >= date:
                continue
            cached_symbols = read_json(path)
            if isinstance(cached_symbols, dict):
                add(as_of, cached_symbols)
    if not candidates:
        return None
    return max(candidates, key=lambda item: (item['exact'], item['date'], item['count'], item['codes'] is not None))


def validate_universe_scope(date, symbols, reference=None):
    if (not isinstance(symbols, dict) or len(symbols) < 4000 or
            any(not isinstance(code, str) or len(code) != 8 or
                not valid_code(code[2:] + '.' + code[:2].upper()) for code in symbols)):
        raise ValueError(f'{date}: invalid or undersized daily universe')
    if reference is None:
        return symbols
    codes, expected = set(symbols), reference['codes']
    if reference['exact']:
        if codes != expected:
            missing = len(expected - codes)
            extra = len(codes - expected)
            raise ValueError(f'{date}: published roster differs from calibrated same-day roster ({missing} missing, {extra} extra)')
    else:
        minimum = math.ceil(reference['count'] * .995)
        if len(codes) < minimum or (expected is not None and len(codes & expected) < minimum):
            raise ValueError(f'{date}: daily roster still incomplete ({len(codes)} vs {reference["count"]} on {reference["date"]})')
    return symbols


def load_universe(date, cache_dir=None, refresh=False, now=None):
    """Recent caches are mutable until publication settles; validate before write."""
    now = now or dt.datetime.now(TZ)
    reference = universe_reference(date, cache_dir)
    path = cache_dir / ('universe-' + date + '.json') if cache_dir is not None else None
    recent = (now.date() - dt.date.fromisoformat(date)).days <= 7
    if path is not None and not refresh and not recent:
        stored = read_json(path)
        if stored is not None:
            try:
                return validate_universe_scope(date, stored, reference)
            except ValueError:
                pass
    symbols = validate_universe_scope(date, fetch_universe(date), reference)
    if date == now.date().isoformat() and reference is None:
        raise ValueError(f'{date}: current-day roster lacks an independent completeness reference')
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(symbols, ensure_ascii=False, separators=(',', ':')))
        temporary.replace(path)
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
    hosts = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
             'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
             'https://push2his.eastmoney.com/api/qt/stock/kline/get')
    # A source-wide outage should not incur the same long timeout for every
    # stock. Pause that endpoint briefly; still probe it again after cooldown.
    while not any(daily_source_ready(host) for host in hosts):
        check_deadline()
        time.sleep(1)
    for host in hosts:
        check_deadline()
        if not daily_source_ready(host):
            errors.append(host + ': brief source cooldown')
            continue
        try:
            if host == hosts[-1]:
                # Each successful fallback supplies a whole adjusted history.
                result = fetch_eastmoney_bars(code)
            else:
                payload = get_json(host + '?' + urlencode({'param': f'{code},day,,,500,qfq'}), attempts=1)
                result = parse_bars(payload, code)
            daily_source_result(host, True)
            return result
        except Exception as exc:
            daily_source_result(host, False)
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


def complete_cached_snapshots(latest, now=None, cache_dir=None):
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
        structurally_complete = (len(previous) == 60 and previous[-1].get('date') == latest and
                baseline.get('asOfDate') == latest and bool(baseline.get('validThrough')) and
                bool(baseline.get('stocks')))
        if not structurally_complete:
            return False
        published = load_universe(latest, cache_dir, refresh=True, now=now)
        codes = {row['code'] for row in baseline['stocks']}
        return (codes == set(published) and len(codes) == len(baseline['stocks']) == previous[-1].get('universe') and
                {row['code'] for row in ma_baseline['stocks']} == codes)
    except (OSError, RuntimeError, TypeError, ValueError, IndexError, AttributeError, KeyError, OverflowError):
        return False


def parallel_map(items, fn, workers=6, label='fetch', attempts=3):
    result, errors = {}, {}
    pending = list(items)
    def collect(item):
        check_deadline()
        return fn(item)
    for attempt in range(max(1, min(attempts, 3))):
        check_deadline()
        if attempt:
            # A short bounded cooldown; retry only missing symbols, preserving
            # successful same-run histories in their original adjustment basis.
            time.sleep((5, 15)[attempt - 1])
            print(f'{label}: retry {attempt}, {len(pending)} missing items', flush=True)
        errors = {}
        total = len(pending)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(collect, item): item for item in pending}
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
    if not force and complete_cached_snapshots(latest, now, cache_dir):
        print(f'Complete {latest} close snapshots already available; retained.', flush=True)
        return
    if latest == now.date().isoformat():
        try:
            load_universe(latest, cache_dir, refresh=True, now=now)
        except Exception as exc:
            # The daily constituent table is often released later than the
            # closing quote. Repair yesterday now, never label it as today.
            existing = read_json(OUTPUT)
            if isinstance(existing, dict) and (existing.get('series') or [{}])[-1].get('date') == latest:
                raise RuntimeError(f'{latest}: roster verification unavailable; retaining existing dated snapshots') from exc
            dates = available_dates[:-1][-60:]
            if len(dates) != 60:
                raise RuntimeError('Need 60 published sessions before current universe is released') from exc
            latest = dates[-1]
            print(f'Today constituent table unavailable; repairing through {latest}: {exc}', flush=True)
            if not force and complete_cached_snapshots(latest, now, cache_dir):
                return
    print(f'Building {dates[0]} → {latest}', flush=True)
    universes = parallel_map(dates, lambda date: load_universe(date, cache_dir, refresh=date == latest, now=now), workers, 'universes')
    symbols = sorted(set().union(*(set(value) for value in universes.values())))
    # All histories use the same adjustment vintage; reuse only within this
    # completed-session build, never merge differently adjusted raw bars.
    prices = parallel_map(symbols, lambda code: cached_bars(cache_dir, latest, code,
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
    global _REFRESH_DEADLINE
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, default=Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'high-low-52w-cache')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--force', action='store_true', help='Rebuild even on a non-trading day')
    parser.add_argument('--max-seconds', type=int, default=1500,
                        help='Leave time to save successful symbol caches before the job timeout')
    args = parser.parse_args()
    _REFRESH_DEADLINE = time.monotonic() + max(60, args.max_seconds)
    try:
        refresh_history(args.cache_dir, max(1, min(args.workers, 10)), args.force)
    finally:
        # ThreadPoolExecutor has joined all workers before refresh_history
        # returns or raises, so no cache file is being written during pruning.
        prune_dated_history_caches(args.cache_dir)


if __name__ == '__main__':
    main()


