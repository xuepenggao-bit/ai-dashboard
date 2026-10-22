#!/usr/bin/env python3
"""Publish a verified 15:00 quote snapshot before the daily universe is released.

This deliberately writes a separate provisional artifact: the last verified
roster is identified, and the slower official daily-calibrated history wins.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import importlib.util
import json
import math
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

SPEC = importlib.util.spec_from_file_location('quality_official', Path(__file__).with_name('refresh_market_quality.py'))
official = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(official)
TZ, ROOT = official.TZ, official.ROOT
INDICES = ('sh000001', 'sz399106')
SOURCE = '腾讯财经当日完整收盘行情 · 最近已核验沪深A股名单'
METHOD = ('按最近已核验沪深A股名单统计当日有成交股票；收益使用行情源当日涨跌幅，'
          '成交额使用行情源实际人民币金额；前20只成交额合计除以同范围总额。'
          '收盘快照为暂定值，股票名单日期单独注明，晚间由当日正式名单校准。')


def normalized_now(now=None):
    now = now or dt.datetime.now(TZ)
    if now.tzinfo is None:
        raise ValueError('Ambiguous current time')
    return now.astimezone(TZ)


def validate_baseline(data, now, minimum=4000):
    if data.get('schemaVersion') != 1 or data.get('scope') != '沪深A股':
        raise ValueError('Invalid verified roster schema/scope')
    date = dt.date.fromisoformat(data['asOfDate'])
    if not 0 <= (now.date() - date).days <= 20:
        raise ValueError('Verified roster is stale or future dated')
    stocks = data.get('stocks')
    if not isinstance(stocks, list) or not minimum <= len(stocks) <= 10000:
        raise ValueError('Incomplete verified roster')
    seen = set()
    for stock in stocks:
        code = stock['code']
        if not official.valid_symbol(code) or code in seen:
            raise ValueError('Invalid/duplicate roster security')
        seen.add(code)
        official.number(stock['close'], positive=True)
        if dt.date.fromisoformat(stock['lastDate']) > date:
            raise ValueError('Future roster quote')
    return data


def parse_quotes(text, codes):
    wanted, quotes = set(codes), {}
    for match in re.finditer(r'v_((?:sh|sz)\d{6})="([^"]*)"', text):
        code = match[1]
        if code not in wanted:
            continue
        fields = match[2].split('~')
        if code in quotes or len(fields) < 38 or fields[2] != code[2:]:
            raise ValueError(f'{code}: malformed/duplicate quote')
        if not re.fullmatch(r'\d{14}', fields[30]):
            raise ValueError(f'{code}: invalid quote timestamp')
        stamp = dt.datetime.strptime(fields[30], '%Y%m%d%H%M%S').replace(tzinfo=TZ)
        price, previous = (official.number(fields[i], positive=True) for i in (3, 4))
        volume, amount, change = (official.number(fields[i]) for i in (6, 37, 32))
        if volume < 0 or amount < 0 or change <= -100:
            raise ValueError(f'{code}: invalid quote values')
        quotes[code] = {'price': price, 'previous': previous, 'volume': volume,
                        'amountYuan': amount * 10000, 'returnPct': change, 'stamp': stamp}
    missing = wanted - set(quotes)
    if missing:
        raise ValueError(f'Incomplete quote batch: {len(missing)} missing')
    return quotes


def fetch_quotes(codes, attempts=2):
    if not codes or len(codes) > 80 or len(set(codes)) != len(codes):
        raise ValueError('Quote batch must contain 1–80 unique symbols')
    error = None
    for attempt in range(attempts):
        try:
            request = Request('https://qt.gtimg.cn/q=' + ','.join(codes), headers={
                'User-Agent': official.UA, 'Referer': 'https://gu.qq.com/', 'Cache-Control': 'no-cache'})
            with urlopen(request, timeout=15) as response:
                return parse_quotes(response.read().decode('gb18030'), codes)
        except Exception as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(.5)
    raise RuntimeError(f'Closing quote batch unavailable: {error}')


def validate_stamp(quote, now, require_close=True):
    stamp = quote['stamp']
    if stamp.tzinfo is None or stamp.astimezone(TZ).date() != now.date() or stamp > now:
        raise ValueError('Quote is not from the current day or is future dated')
    if require_close and stamp.astimezone(TZ).time() < dt.time(15):
        raise ValueError('Quote has not reached the 15:00 close')


def market_closed(indices, now):
    if now.weekday() >= 5 or now.time() < dt.time(15):
        return False
    if set(indices) != set(INDICES):
        raise ValueError('Incomplete exchange close confirmation')
    # Weekdays can be exchange holidays: stale index dates are not a new close.
    if any(q['stamp'].astimezone(TZ).date() < now.date() for q in indices.values()):
        return False
    for quote in indices.values():
        validate_stamp(quote, now)
        official.number(quote['volume'], positive=True)
        official.number(quote['amountYuan'], positive=True)
    return True


def collect_quotes(codes, workers=4):
    batches = [codes[i:i + 80] for i in range(0, len(codes), 80)]
    quotes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, 4))) as pool:
        # Executor cleanup waits for all submitted requests before propagating
        # a failed batch. A partial scan can never be published as a full scan.
        for batch in pool.map(fetch_quotes, batches):
            if set(quotes).intersection(batch):
                raise ValueError('Duplicate quote batch security')
            quotes.update(batch)
    if set(quotes) != set(codes):
        raise ValueError('Incomplete full-market quote scan')
    return quotes


def build_close_day(baseline, quotes, now, minimum=4000):
    now = normalized_now(now)
    if now.weekday() >= 5 or now.time() < dt.time(15):
        raise ValueError('The exchange session is not closed')
    validate_baseline(baseline, now, minimum)
    stocks = {stock['code']: stock for stock in baseline['stocks']}
    if set(quotes) != set(stocks):
        raise ValueError('Incomplete full-market quote coverage')
    universe, prices = {}, {}
    date = now.date().isoformat()
    for code, stock in stocks.items():
        quote = quotes[code]
        price = official.number(quote['price'], positive=True)
        previous = official.number(quote['previous'], positive=True)
        volume, amount, change = [official.number(quote[k]) for k in ('volume', 'amountYuan', 'returnPct')]
        if volume < 0 or amount < 0 or (volume == 0) != (amount == 0):
            raise ValueError(f'{code}: inconsistent traded volume/amount')
        # A timestamped explicit 0/0 is excluded, never a missing/old quote.
        validate_stamp(quote, now, require_close=volume > 0)
        if change <= -100 or abs(change - (price / previous - 1) * 100) > .020001:
            raise ValueError(f'{code}: daily return disagrees with current/previous price')
        universe[code] = {'name': stock.get('name', ''), 'close': price, 'change': change}
        prices[code] = [{'date': date, 'close': price, 'amountYuan': amount}]
    row = official.build_day(date, universe, prices, minimum=minimum)
    row.update(provisional=True, universeAsOf=baseline['asOfDate'])
    return row


def validate_close_payload(payload, now):
    if payload.get('schemaVersion') != 1 or payload.get('scope') != '沪深A股':
        raise ValueError('Invalid closing snapshot schema/scope')
    updated = dt.datetime.fromisoformat(payload['updatedAt'])
    if updated.tzinfo is None or updated > now:
        raise ValueError('Invalid snapshot timestamp')
    rows = payload.get('series')
    if not isinstance(rows, list) or len(rows) != 60:
        raise ValueError('Require 60 observed trading sessions')
    dates = [dt.date.fromisoformat(row['date']).isoformat() for row in rows]
    if dates != sorted(set(dates)) or dates[-1] > updated.astimezone(TZ).date().isoformat():
        raise ValueError('Invalid snapshot dates')
    if dates[-1] == updated.astimezone(TZ).date().isoformat() and updated.astimezone(TZ).time() < dt.time(15):
        raise ValueError('Snapshot predates the close')
    for row in rows:
        if row.get('status') != 'close' or row.get('asOf') != '15:00':
            raise ValueError('Invalid close status')
        if dt.date.fromisoformat(row['date']).weekday() >= 5:
            raise ValueError('Weekend snapshot')
        if row.get('provisional') is not None and row['provisional'] is not True:
            raise ValueError('Invalid provisional status')
        if row.get('provisional'):
            age = (dt.date.fromisoformat(row['date']) - dt.date.fromisoformat(row['universeAsOf'])).days
            if not 0 <= age <= 20:
                raise ValueError('Invalid provisional universe date')
        if not 4000 <= row['eligibleCount'] <= row['universeCount'] <= 10000:
            raise ValueError('Incomplete snapshot coverage')
        q25, median, q75 = [official.number(row[k]) for k in ('q25ReturnPct', 'medianReturnPct', 'q75ReturnPct')]
        if not -100 < q25 <= median <= q75:
            raise ValueError('Invalid snapshot distribution')
        top = row['top20']
        if len(top) != 20 or row['top20Count'] != 20 or len({r['code'] for r in top}) != 20:
            raise ValueError('Invalid snapshot top20')
        if any(not official.valid_symbol(r['code']) for r in top):
            raise ValueError('Invalid snapshot security')
        actual = math.fsum(official.number(r['amountYuan'], positive=True) for r in top)
        top_amount = official.number(row['top20AmountYuan'], positive=True)
        total = official.number(row['totalAmountYuan'], positive=True)
        if abs(actual - top_amount) > .1 or top_amount > total:
            raise ValueError('Invalid snapshot amount sums')
        if abs(official.number(row['top20SharePct'], positive=True) - 100 * top_amount / total) > .000001:
            raise ValueError('Invalid snapshot concentration')
    return payload


def refresh(output, baseline_path, official_path, workers=4, now=None):
    use_wall_clock = now is None
    now = normalized_now(now)
    if now.weekday() >= 5 or now.time() < dt.time(15):
        print('Skip: before the A-share close or weekend', flush=True)
        return None
    history = official.validate_payload(json.loads(Path(official_path).read_text()))
    today = now.date().isoformat()
    if history['series'][-1]['date'] > today:
        raise ValueError('Reject official history date regression')
    if history['series'][-1]['date'] == today:
        print('Skip: verified daily history is already current', flush=True)
        return None
    indices = fetch_quotes(INDICES)
    if use_wall_clock:
        now = normalized_now()
    if now.date().isoformat() != today:
        raise ValueError('Session changed while confirming the close')
    if not market_closed(indices, now):
        print('Skip: indices do not confirm a current-day exchange close', flush=True)
        return None
    baseline = validate_baseline(json.loads(Path(baseline_path).read_text()), now)
    prior = validate_close_payload(json.loads(Path(output).read_text()), now) if Path(output).exists() else None
    if prior and prior['series'][-1]['date'] > today:
        raise ValueError('Reject closing snapshot date regression')
    quotes = collect_quotes([s['code'] for s in baseline['stocks']], workers)
    # Use completion time in production, so 15:00:xx quotes returned during a
    # scan started at 15:00 are not mistaken for future timestamps.
    completed = normalized_now() if use_wall_clock else now
    if completed.date().isoformat() != today:
        raise ValueError('Session changed during the closing quote scan')
    row = build_close_day(baseline, quotes, completed)
    rows = {r['date']: r for r in (prior['series'] if prior else [])}
    # The calibrated official result takes precedence over provisional history.
    rows.update({r['date']: r for r in history['series']})
    rows[today] = row
    payload = {'schemaVersion': 1, 'scope': '沪深A股', 'updatedAt': completed.isoformat(timespec='seconds'),
               'source': SOURCE, 'sourceUrl': 'https://gu.qq.com/', 'methodology': METHOD,
               'series': [rows[d] for d in sorted(rows)[-60:]]}
    validate_close_payload(payload, completed)
    # No file is touched until the entire scan and resulting history validate.
    official.atomic_json(output, payload)
    print(json.dumps({'asOf': today, 'universeAsOf': baseline['asOfDate'],
                      'eligibleCount': row['eligibleCount'], 'medianReturnPct': row['medianReturnPct'],
                      'top20SharePct': row['top20SharePct'], 'provisional': True}, ensure_ascii=False), flush=True)
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'data/market_quality_close.json')
    parser.add_argument('--baseline', type=Path, default=ROOT / 'data/market_quality_baseline.json')
    parser.add_argument('--official', type=Path, default=ROOT / 'data/market_quality.json')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    refresh(args.output, args.baseline, args.official, args.workers)


if __name__ == '__main__':
    main()
