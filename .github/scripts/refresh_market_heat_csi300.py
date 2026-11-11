#!/usr/bin/env python3
"""Publish the CSI 300 closing comparison without changing market heat scores."""

import argparse
import datetime as dt
import json
from pathlib import Path
import sys

import refresh_market_risk as risk


SYMBOL = '000300'
LIMIT = 120
READY = dt.time(15, 10)
OUTPUT = risk.ROOT / 'data/market_heat_csi300.json'
HEAT = risk.ROOT / 'data/market_heat.json'


def validate(payload, now):
    if type(payload.get('schemaVersion')) is not int or payload['schemaVersion'] != 1 or payload.get('symbol') != SYMBOL:
        raise ValueError('wrong benchmark snapshot schema or symbol')
    updated = dt.datetime.fromisoformat(payload['updatedAt'])
    if updated.tzinfo is None or updated > now + dt.timedelta(minutes=2):
        raise ValueError('invalid benchmark snapshot timestamp')
    cutoff = min(updated.astimezone(risk.TZ), now)
    series = payload.get('series')
    if not isinstance(series, list) or not 60 <= len(series) <= LIMIT:
        raise ValueError('insufficient or oversized benchmark history')
    last = None
    for row in series:
        date = risk.parse_date(row['date'])
        if (last and date <= last) or date > cutoff.date() or (date == cutoff.date() and cutoff.time() < READY):
            raise ValueError('duplicate, unordered or uncompleted benchmark day')
        if type(row['close']) not in (float, int):
            raise ValueError('benchmark close must be numeric')
        risk.finite_number(row['close'], positive=True)
        last = date


def make_snapshot(bars, now, source, source_url, required_dates, previous=None):
    today = now.date().isoformat()
    series = [
        {'date': row['date'], 'close': row['close']}
        for row in bars if row['date'] != today or now.time() >= READY
    ][-LIMIT:]
    result = {'schemaVersion': 1, 'symbol': SYMBOL, 'updatedAt': now.isoformat(timespec='seconds'),
              'source': source, 'sourceUrl': source_url, 'series': series}
    validate(result, now)
    dates = {row['date'] for row in series}
    if not set(required_dates).issubset(dates):
        raise ValueError('benchmark does not cover all published market heat dates')
    if previous:
        old = previous['series']
        if series[-1]['date'] < old[-1]['date']:
            raise ValueError('benchmark latest date regressed')
        if any(row['date'] >= series[0]['date'] and row['date'] not in dates for row in old):
            raise ValueError('benchmark has a gap in previously published history')
        if series == old:
            return previous
    return result


def refresh(output, heat, now=None):
    now = (now or risk.local_now()).astimezone(risk.TZ)
    required = [row['date'] for row in json.loads(heat.read_text(encoding='utf-8'))['series']]
    previous = None
    if output.exists():
        previous = json.loads(output.read_text(encoding='utf-8'))
        validate(previous, now)
    bars, source, source_url = risk.fetch_bars(now, code='sh' + SYMBOL)
    result = make_snapshot(bars, now, source, source_url, required, previous)
    if result is not previous:
        output.parent.mkdir(parents=True, exist_ok=True)
        temp = output.with_suffix('.json.tmp')
        temp.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        temp.replace(output)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--heat', type=Path, default=HEAT)
    args = parser.parse_args()
    try:
        result = refresh(args.output, args.heat)
    except Exception as exc:
        print(f'CSI 300 close refresh failed; existing data retained: {exc}', file=sys.stderr)
        return 1
    print(json.dumps({'symbol': SYMBOL, 'dates': len(result['series']), 'latest': result['series'][-1]}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
