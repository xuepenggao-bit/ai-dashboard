#!/usr/bin/env python3
"""Real Shanghai/Shenzhen A-share return distribution and amount concentration.

Point-in-time daily universes/official daily change rates: Eastmoney daily
valuation table. Actual unadjusted traded amounts: Tencent extended daily bars
(ten thousand yuan), with Eastmoney raw daily bars (yuan) as fallback.
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
import statistics
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TZ = dt.timezone(dt.timedelta(hours=8))
ROOT = Path(__file__).resolve().parents[2]
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
SOURCE = '东方财富每日估值表（每日名单、涨跌幅） · 腾讯财经扩展未复权日线（成交额）；新浪日线交叉核验无成交日，东方财富未复权日线备用'
METHOD = ('沪深A股（含ST，不含北交所、B股、基金）；按每个交易日当时的股票名单，'
          '仅统计当日有成交且涨跌幅有效的股票；中位数及25%/75%分位使用源站当日涨跌幅，分位采用线性插值；'
          '成交额集中度=该日成交额最高20只股票成交额合计/同范围全部股票成交额合计×100%；'
          '成交额为实际人民币成交金额，不由成交量乘收盘价推算。')


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
                time.sleep(.4 * (attempt + 1))
    raise RuntimeError(f'{url.split("?")[0]}: {error}')


def number(value, positive=False):
    if isinstance(value, bool):
        raise ValueError('boolean numeric value')
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError('invalid numeric value')
    return result


def valid_symbol(value):
    return bool(re.fullmatch(r'sh(?:60|68)\d{4}|sz(?:00|30)\d{4}', str(value)))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    temp.replace(path)


def read_cache(path, loader):
    path = Path(path)
    if path.exists():
        return json.loads(path.read_text())
    value = loader()
    atomic_json(path, value)
    return value


def fetch_calendar(now):
    payload = get_json('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?' + urlencode({
        'param': 'sh000001,day,,,180,'}))
    rows = (payload.get('data') or {}).get('sh000001', {}).get('day')
    if payload.get('code') != 0 or not isinstance(rows, list):
        raise ValueError('No trading calendar')
    today = now.date().isoformat()
    dates = []
    for row in rows:
        day = dt.date.fromisoformat(row[0]).isoformat()
        if day < today or (day == today and now.time() >= dt.time(15, 10)):
            if dt.date.fromisoformat(day).weekday() >= 5:
                raise ValueError('Weekend trading calendar date')
            dates.append(day)
    if dates != sorted(set(dates)) or len(dates) < 60:
        raise ValueError('Incomplete trading calendar')
    if (now.date() - dt.date.fromisoformat(dates[-1])).days > 12:
        raise ValueError('Stale calendar')
    return dates[-60:]


def fetch_valuations(date):
    payload = get_json('https://datacenter-web.eastmoney.com/api/data/v1/get?' + urlencode({
        'reportName': 'RPT_VALUEANALYSIS_DET',
        'columns': 'SECUCODE,SECURITY_NAME_ABBR,TRADE_DATE,CLOSE_PRICE,CHANGE_RATE',
        'pageSize': 10000, 'pageNumber': 1, 'sortColumns': 'SECURITY_CODE',
        'sortTypes': '1', 'filter': f"(TRADE_DATE='{date}')", 'source': 'WEB', 'client': 'WEB',
    }))
    result = payload.get('result') or {}
    raw = result.get('data') or []
    if not payload.get('success') or len(raw) != result.get('count'):
        raise ValueError(f'{date}: incomplete daily universe')
    values = {}
    for row in raw:
        raw_code = str(row.get('SECUCODE', ''))
        code = raw_code[-2:].lower() + raw_code[:6]
        if not valid_symbol(code):
            continue
        if str(row.get('TRADE_DATE', ''))[:10] != date or code in values:
            raise ValueError(f'{date}: mismatched/duplicate universe row')
        close = number(row['CLOSE_PRICE'], positive=True)
        change = None if row.get('CHANGE_RATE') is None else number(row['CHANGE_RATE'])
        if change is not None and change < -100:
            raise ValueError(f'{date} {code}: impossible return')
        values[code] = {'name': str(row.get('SECURITY_NAME_ABBR', '')),
                        'close': close, 'change': change}
    if len(values) < 4000:
        raise ValueError(f'{date}: suspicious universe size {len(values)}')
    return values


def parse_tencent_bars(payload, code):
    item = (payload.get('data') or {}).get(code) or {}
    raw = item.get('day')
    if payload.get('code') != 0 or not isinstance(raw, list) or not raw:
        raise ValueError(f'{code}: no extended unadjusted daily bars')
    rows = []
    for row in raw:
        day = dt.date.fromisoformat(row[0]).isoformat()
        close, high, low, volume = map(number, (row[2], row[3], row[4], row[5]))
        amount = number(row[8]) * 10000
        if min(close, high, low) <= 0 or low > high or volume < 0 or amount < 0:
            raise ValueError(f'{code} {day}: invalid OHLC/amount')
        # Tencent's STAR-board history volume is shares; other A shares use
        # board lots. Amount remains ten thousand yuan for both conventions.
        if volume > 0 and amount > 0:
            average = amount / (volume * (1 if code.startswith('sh68') else 100))
            tolerance = max(.03, high * .002)
            if not low - tolerance <= average <= high + tolerance:
                raise ValueError(f'{code} {day}: amount/volume unit inconsistency')
        if (volume == 0) != (amount == 0):
            raise ValueError(f'{code} {day}: inconsistent zero amount')
        rows.append({'date': day, 'close': close, 'amountYuan': amount})
    if [r['date'] for r in rows] != sorted({r['date'] for r in rows}):
        raise ValueError(f'{code}: duplicate/out-of-order daily bars')
    return rows


def parse_eastmoney_bars(payload, code):
    data = payload.get('data') or {}
    if data.get('code') != code[2:] or data.get('market') != (1 if code.startswith('sh') else 0):
        raise ValueError(f'{code}: mismatched fallback security')
    raw = data.get('klines')
    if not isinstance(raw, list) or not raw:
        raise ValueError(f'{code}: no fallback bars')
    rows = []
    for line in raw:
        row = line.split(',')
        day = dt.date.fromisoformat(row[0]).isoformat()
        close, high, low, volume, amount = map(number, (row[2], row[3], row[4], row[5], row[6]))
        if min(close, high, low) <= 0 or low > high or min(volume, amount) < 0:
            raise ValueError(f'{code}: invalid fallback OHLC')
        if volume and amount:
            average = amount / (volume * 100)
            if not low - .03 <= average <= high + .03:
                raise ValueError(f'{code}: invalid fallback amount units')
        if (volume == 0) != (amount == 0):
            raise ValueError(f'{code}: inconsistent fallback zero amount')
        rows.append({'date': day, 'close': close, 'amountYuan': amount})
    if [r['date'] for r in rows] != sorted({r['date'] for r in rows}):
        raise ValueError(f'{code}: duplicate fallback date')
    return rows


def fetch_amount_bars(code, start, latest):
    errors = []
    for host in ('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
                 'https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get'):
        try:
            payload = get_json(host + '?' + urlencode({'param': f'{code},day,,,120,'}), attempts=2)
            return parse_tencent_bars(payload, code)
        except Exception as exc:
            errors.append(str(exc))
    try:
        payload = get_json('https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urlencode({
            'secid': ('1.' if code.startswith('sh') else '0.') + code[2:],
            'klt': 101, 'fqt': 0, 'beg': start.replace('-', ''), 'end': latest.replace('-', ''),
            'fields1': 'f1,f2,f3,f4,f5,f6',
            'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
        }))
        return parse_eastmoney_bars(payload, code)
    except Exception as exc:
        errors.append(str(exc))
    raise RuntimeError(f'{code}: all actual amount sources failed: {errors}')


def percentile(sorted_values, p):
    if not sorted_values:
        raise ValueError('Empty return distribution')
    pos = (len(sorted_values) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def fetch_sina_volume_bars(code, start, latest):
    """Independent raw OHLCV; absence is useful only after coverage checks."""
    payload = get_json('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
                       'CN_MarketData.getKLineData?' + urlencode({
                           'symbol': code, 'scale': 240, 'ma': 'no', 'datalen': 240,
                       }), attempts=2)
    if not isinstance(payload, list) or not payload:
        raise ValueError(f'{code}: no independent daily history')
    bars = []
    for row in payload:
        day = dt.date.fromisoformat(str(row['day'])[:10]).isoformat()
        close = number(row['close'], positive=True)
        high, low = number(row['high'], positive=True), number(row['low'], positive=True)
        volume = number(row['volume'])
        if volume < 0 or not low <= close <= high or dt.date.fromisoformat(day).weekday() >= 5:
            raise ValueError(f'{code}: invalid independent daily history')
        bars.append({'date': day, 'close': close, 'volume': volume})
    if [r['date'] for r in bars] != sorted({r['date'] for r in bars}):
        raise ValueError(f'{code}: unordered independent daily history')
    # Keep the warm-up rows as proof that the fixed-capacity response covers
    # the beginning of the requested period; overlap completeness is checked
    # separately before any missing session is accepted as nontrading.
    return bars


def fetch_eastmoney_amount_bars(code, start, latest):
    payload = get_json('https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urlencode({
        'secid': ('1.' if code.startswith('sh') else '0.') + code[2:],
        'klt': 101, 'fqt': 0, 'beg': start.replace('-', ''), 'end': latest.replace('-', ''),
        'lmt': 1000, 'fields1': 'f1,f2,f3,f4,f5,f6',
        'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    }), attempts=1)
    rows = parse_eastmoney_bars(payload, code)
    if len(rows) >= 1000 or any(not start <= r['date'] <= latest for r in rows):
        raise ValueError(f'{code}: ambiguous fallback history range')
    return rows


def reconcile_missing_sessions(universes, prices, start, latest, workers=6, cache_dir=None):
    """Confirm absent Tencent sessions independently; never infer halt from 0%."""
    required = {}
    for day, universe in universes.items():
        for code, info in universe.items():
            if code not in prices:
                raise ValueError(f'{day}: incomplete historical securities')
            if day not in {r['date'] for r in prices[code]}:
                if info['change'] not in (None, 0):
                    raise ValueError(f'{day} {code}: daily universe reports return but amount bar is missing')
                required.setdefault(code, {})[day] = info
    verified = set()

    def task(item):
        code, missing = item
        known = {r['date']: r for r in prices[code] if start <= r['date'] <= latest}
        if not known:
            raise ValueError(f'{code}: no known daily sessions to validate independent coverage')
        path = Path(cache_dir) / 'verification' / f'{code}.json' if cache_dir else None
        cached = json.loads(path.read_text()) if path and path.exists() else None
        if (cached and cached.get('schemaVersion') == 1 and cached.get('source') == 'sina-raw-daily-ohlcv'
                and cached.get('start') == start and cached.get('through') == latest):
            independent = cached['bars']
        else:
            independent = fetch_sina_volume_bars(code, start, latest)
        all_dates = [dt.date.fromisoformat(r['date']).isoformat() for r in independent]
        if (not all_dates or all_dates != sorted(set(all_dates)) or all_dates[0] >= start
                or all_dates[-1] < max(known)
                or any(number(r['close'], positive=True) <= 0 or number(r['volume']) < 0
                       for r in independent)):
            raise ValueError(f'{code}: incomplete independent daily history')
        secondary = {r['date']: r for r in independent if start <= r['date'] <= latest}
        for day, row in known.items():
            other = secondary.get(day)
            if not other or (row['amountYuan'] > 0 and other['volume'] <= 0):
                raise ValueError(f'{code} {day}: independent history is missing a known traded session')
            if abs(row['close'] - other['close']) > max(.011, row['close'] * .0001):
                raise ValueError(f'{code} {day}: independent raw close disagrees')
        traded_missing = [day for day in missing if secondary.get(day, {}).get('volume', 0) > 0]
        additions = []
        if traded_missing:
            fallback = {r['date']: r for r in fetch_eastmoney_amount_bars(code, start, latest)}
            for day in traded_missing:
                row = fallback.get(day)
                if not row or row['amountYuan'] <= 0:
                    raise ValueError(f'{code} {day}: traded session lacks independently confirmed actual amount')
                if abs(row['close'] - missing[day]['close']) > max(.011, missing[day]['close'] * .0001):
                    raise ValueError(f'{code} {day}: recovered raw close disagrees with daily universe')
                if abs(row['close'] - secondary[day]['close']) > max(.011, row['close'] * .0001):
                    raise ValueError(f'{code} {day}: recovery and independent raw close disagree')
                additions.append(row)
        if path:
            atomic_json(path, {'schemaVersion': 1, 'source': 'sina-raw-daily-ohlcv',
                               'start': start, 'through': latest, 'bars': independent})
        return code, additions, {(code, day) for day in missing if day not in traded_missing}

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for code, additions, nontrading in pool.map(task, required.items()):
            prices[code] = sorted(prices[code] + additions, key=lambda r: r['date'])
            verified.update(nontrading)
    print(f'Independent missing-session verification: {len(required)} securities, '
          f'{len(verified)} confirmed nontrading stock-days', flush=True)
    return verified


def build_day(date, universe, prices, minimum=4000, verified_nontrading=None):
    changes, amounts = [], []
    if set(universe) - set(prices):
        raise ValueError(f'{date}: incomplete historical securities')
    for code, info in universe.items():
        by_date = {r['date']: r for r in prices[code]}
        row = by_date.get(date)
        if row is None and (info['change'] not in (None, 0) or
                            (code, date) not in (verified_nontrading or set())):
            raise ValueError(f'{date} {code}: amount bar is missing without independent nontrading verification')
        if row is None or row['amountYuan'] == 0:
            continue
        if abs(row['close'] - info['close']) > max(.011, info['close'] * .0001):
            raise ValueError(f'{date} {code}: unadjusted close disagrees with daily universe')
        amount = number(row['amountYuan'], positive=True)
        if info['change'] is None:
            raise ValueError(f'{date} {code}: missing traded-stock daily return')
        change = number(info['change'])
        changes.append(change)
        amounts.append({'code': code, 'name': info['name'], 'amountYuan': round(amount, 2)})
    if len(changes) < minimum:
        raise ValueError(f'{date}: too few active stocks {len(changes)}')
    changes.sort()
    amounts.sort(key=lambda row: (-row['amountYuan'], row['code']))
    total = math.fsum(row['amountYuan'] for row in amounts)
    top = amounts[:20]
    top_amount = math.fsum(row['amountYuan'] for row in top)
    return {'date': date, 'asOf': '15:00', 'status': 'close',
            'eligibleCount': len(changes), 'universeCount': len(universe),
            'medianReturnPct': round(statistics.median(changes), 6),
            'q25ReturnPct': round(percentile(changes, .25), 6),
            'q75ReturnPct': round(percentile(changes, .75), 6),
            'totalAmountYuan': round(total, 2), 'top20AmountYuan': round(top_amount, 2),
            'top20SharePct': round(100 * top_amount / total, 6),
            'top20Count': len(top), 'top20': top}


def validate_payload(payload, expected_dates=None):
    if payload.get('schemaVersion') != 1 or payload.get('scope') != '沪深A股':
        raise ValueError('Invalid quality schema/scope')
    rows = payload.get('series')
    if not isinstance(rows, list) or len(rows) != 60:
        raise ValueError('Require exactly 60 actual trading sessions')
    dates = [dt.date.fromisoformat(r['date']).isoformat() for r in rows]
    if dates != sorted(set(dates)) or (expected_dates and dates != expected_dates):
        raise ValueError('Wrong historical dates')
    updated = dt.datetime.fromisoformat(payload['updatedAt'])
    if updated.tzinfo is None or dates[-1] > updated.astimezone(TZ).date().isoformat():
        raise ValueError('Future/ambiguous source date')
    if dates[-1] == updated.astimezone(TZ).date().isoformat() and updated.astimezone(TZ).time() < dt.time(15, 10):
        raise ValueError('Unfinished session cannot be close')
    for row in rows:
        if row.get('status') != 'close' or row.get('asOf') != '15:00':
            raise ValueError('Invalid completed status')
        if not 4000 <= row['eligibleCount'] <= row['universeCount'] <= 10000:
            raise ValueError('Invalid securities coverage')
        q25, median, q75 = [number(row[k]) for k in ('q25ReturnPct', 'medianReturnPct', 'q75ReturnPct')]
        if not -100 <= q25 <= median <= q75:
            raise ValueError('Invalid return distribution')
        top = row['top20']
        if len(top) != 20 or row.get('top20Count') != 20 or len({r['code'] for r in top}) != 20:
            raise ValueError('Invalid top20 members')
        if any(not valid_symbol(r['code']) for r in top):
            raise ValueError('Invalid top20 security scope')
        actual = math.fsum(number(r['amountYuan'], positive=True) for r in top)
        top_amount = number(row['top20AmountYuan'], positive=True)
        total = number(row['totalAmountYuan'], positive=True)
        if abs(actual - top_amount) > .1 or not top_amount <= total:
            raise ValueError('Invalid amount sums')
        share = number(row['top20SharePct'], positive=True)
        if abs(share - 100 * top_amount / total) > .000001:
            raise ValueError('Invalid concentration ratio')
    return payload


def refresh(output, baseline_output, cache_dir, workers=6, force=False, now=None, rebuild_history=False):
    now = now or dt.datetime.now(TZ)
    dates = fetch_calendar(now)
    old = None
    if Path(output).exists():
        old = validate_payload(json.loads(Path(output).read_text()))
        if old['series'][-1]['date'] > dates[-1]:
            raise ValueError('Reject source date regression')
    cache_dir = Path(cache_dir)
    # Historical published days are immutable; only the newest closed day is
    # recomputed so official corrections can be reflected without full backfill.
    old_rows = {r['date']: r for r in old['series']} if old and not force and not rebuild_history else {}
    needed = [date for date in dates if date not in old_rows or date == dates[-1]]
    universes = {}
    def universe_task(date):
        path = cache_dir / 'universes' / f'{date}.json'
        data = fetch_valuations(date) if force or date == dates[-1] else read_cache(path, lambda: fetch_valuations(date))
        atomic_json(path, data)
        return date, data
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for date, rows in pool.map(universe_task, needed):
            universes[date] = rows
    required = sorted(set().union(*(set(u) for u in universes.values())))
    prices = {}
    completed = 0
    def stock_task(code):
        path = cache_dir / 'amounts' / f'{code}.json'
        cached = json.loads(path.read_text()) if path.exists() else None
        if not force and cached and cached.get('through') == dates[-1] and cached.get('start', '') <= dates[0]:
            return code, cached['bars']
        bars = fetch_amount_bars(code, dates[0], dates[-1])
        bars = [r for r in bars if r['date'] <= dates[-1]]
        atomic_json(path, {'through': dates[-1], 'start': dates[0], 'bars': bars})
        return code, bars
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for code, bars in pool.map(stock_task, required):
            prices[code] = bars
            completed += 1
            if completed % 250 == 0:
                print(f'Historical amounts: {completed}/{len(required)}', flush=True)
    verified_nontrading = reconcile_missing_sessions(universes, prices, dates[0], dates[-1], workers, cache_dir)
    generated = {date: build_day(date, universes[date], prices, verified_nontrading=verified_nontrading)
                 for date in needed}
    updated = now.isoformat(timespec='seconds')
    result = {'schemaVersion': 1, 'updatedAt': updated, 'scope': '沪深A股',
              'source': SOURCE, 'sourceUrl': 'https://data.eastmoney.com/gzfx/list.html',
              'methodology': METHOD, 'verification': {
                  'source': '新浪财经未复权日线 OHLCV',
                  'method': '腾讯缺失且估值表涨跌幅为零的股票日，独立核验完整区间及已知成交日；无成交日不计入样本。',
                  'confirmedNontradingStockDays': len(verified_nontrading),
                  'checkedDates': needed,
              }, 'series': [generated.get(d) or old_rows[d] for d in dates]}
    validate_payload(result, dates)
    baseline = {'schemaVersion': 1, 'updatedAt': updated, 'asOfDate': dates[-1],
                'scope': '沪深A股', 'source': SOURCE, 'methodology': METHOD,
                'stocks': [{'code': code, 'name': info['name'], 'lastDate': dates[-1], 'close': info['close']}
                           for code, info in sorted(universes[dates[-1]].items())]}
    if len(baseline['stocks']) < 4000:
        raise ValueError('Incomplete realtime baseline')
    # Both payloads have been fully computed and validated before either is
    # published. Failed downloads never replace previously valid artifacts.
    atomic_json(output, result)
    atomic_json(baseline_output, baseline)
    print(json.dumps({'asOf': dates[-1], 'days': len(dates), 'latest': result['series'][-1]}, ensure_ascii=False), flush=True)
    return result, baseline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'data/market_quality.json')
    parser.add_argument('--baseline-output', type=Path, default=ROOT / 'data/market_quality_baseline.json')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/market-quality')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--rebuild-history', action='store_true',
                        help='Recompute retained days using validated download caches')
    args = parser.parse_args()
    refresh(args.output, args.baseline_output, args.cache_dir, max(1, min(args.workers, 6)),
            args.force, rebuild_history=args.rebuild_history)


if __name__ == '__main__':
    main()
