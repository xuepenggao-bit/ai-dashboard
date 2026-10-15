#!/usr/bin/env python3
"""Real, lag-aware warm-up data for the A-share market-heat model.

Reuses the market-quality history and its cached actual stock amounts. Daily
updates reuse published warm-up totals; they never rescan the whole market.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
from urllib.parse import urlencode

TZ = dt.timezone(dt.timedelta(hours=8))
ROOT = Path(__file__).resolve().parents[2]
FUNDS = ('510300', '510500', '512100')
SOURCE = ('东方财富逐日沪深A股名单、腾讯实际未复权成交额；东方财富沪市/深市融资余额分市场汇总；上交所清算后ETF总份额')
METHOD = ('成交额采用逐日沪深A股名单、当日有成交的证券实际成交金额合计，和个股收益中位数同口径，'
          '不含北交所、B股与基金；保留20日真实预热历史。杠杆采用沪市(SCDM=007)与深市(SCDM=001)融资余额RZYE相加，'
          '不含融券与北交所；交易所汇总包括其融资标的证券，非严格个股名单。ETF仅3只代表产品，份额单位为份。'
          '融资余额和ETF份额的availableOn统一为下一实际交易日，历史评分仅使用已到可用日期的数据。')


def helper(name, temp):
    candidates = [Path(__file__).with_name(name + '.py'), Path(temp)]
    for path in candidates:
        if path.exists():
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise RuntimeError('Missing helper: ' + name)


Q = helper('refresh_market_quality', '/private/tmp/market-quality-refresh_market_quality.py')
E = helper('refresh_etf_shares', '/private/tmp/environment-risk-refresh_etf_shares.py')


def number(value, positive=True):
    if isinstance(value, bool):
        raise ValueError('Boolean numeric value')
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError('Invalid numeric value')
    return result


def day(value):
    return dt.date.fromisoformat(str(value)[:10]).isoformat()


def atomic_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    temp.replace(path)


def calendar(now):
    p = Q.get_json('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?' + urlencode({'param': 'sh000001,day,,,240,'}))
    rows = (p.get('data') or {}).get('sh000001', {}).get('day')
    if p.get('code') != 0 or not isinstance(rows, list):
        raise ValueError('Missing trading calendar')
    dates = [day(r[0]) for r in rows if r[0] <= now.date().isoformat()]
    if len(dates) < 120 or dates != sorted(set(dates)):
        raise ValueError('Incomplete or unordered calendar')
    if any(dt.date.fromisoformat(d).weekday() >= 5 for d in dates):
        raise ValueError('Weekend in exchange calendar')
    closed = [d for d in dates if d < now.date().isoformat() or now.time().replace(tzinfo=None) >= dt.time(15, 10)]
    if not closed or (now.date() - dt.date.fromisoformat(closed[-1])).days > 12:
        raise ValueError('Stale exchange calendar')
    return dates, closed


def next_session(d, dates):
    pos = bisect_right(dates, d)
    return dates[pos] if pos < len(dates) else None


def validate_rows(rows, value_key, minimum=1):
    if not isinstance(rows, list) or len(rows) < minimum:
        raise ValueError('Insufficient ' + value_key + ' history')
    dates = [day(r['date']) for r in rows]
    if dates != sorted(set(dates)):
        raise ValueError('Unordered/duplicate ' + value_key + ' history')
    for row in rows:
        number(row[value_key])
        if dt.date.fromisoformat(row['date']).weekday() >= 5:
            raise ValueError('Weekend observation')
        if row.get('availableOn') is not None and day(row['availableOn']) <= row['date']:
            raise ValueError('Look-ahead availability')
    return rows


def read_existing(path):
    if not Path(path).exists():
        return None
    p = json.loads(Path(path).read_text())
    if p.get('schemaVersion') != 1 or p.get('scope') != '沪深A股':
        raise ValueError('Invalid existing support schema')
    validate_rows(p['amountHistory']['series'], 'amountYuan', 80)
    validate_rows(p['margin']['series'], 'balanceYuan', 90)
    if {f['code'] for f in p['etf']['funds']} != set(FUNDS):
        raise ValueError('Invalid existing ETF coverage')
    for fund in p['etf']['funds']:
        validate_rows(fund['series'], 'shares', 65)
    return p


def warmup_amounts(required, quality, old, cache_dir, workers=6):
    """Only missing warm-up dates are reconstructed; current 60 days stay exact."""
    by_date = {r['date']: dict(r) for r in (old or {}).get('amountHistory', {}).get('series', [])}
    quality_rows = {r['date']: r for r in quality['series']}
    for d, row in quality_rows.items():
        by_date[d] = {'date': d, 'amountYuan': row['totalAmountYuan']}
    missing = [d for d in required if d not in by_date]
    if missing:
        cache_dir = Path(cache_dir)
        def fetch_universe(d):
            path = cache_dir / 'universes' / (d + '.json')
            values = json.loads(path.read_text()) if path.exists() else Q.fetch_valuations(d)
            if len(values) < 4000 or any(not Q.valid_symbol(code) for code in values):
                raise ValueError(d + ': invalid point-in-time universe')
            Q.atomic_json(path, values)
            return d, values
        with ThreadPoolExecutor(max_workers=workers) as pool:
            universes = dict(pool.map(fetch_universe, missing))
        codes = sorted(set().union(*(set(v) for v in universes.values())))
        prices = {}
        def stock(code):
            path = cache_dir / 'amounts' / (code + '.json')
            p = json.loads(path.read_text()) if path.exists() else None
            # Existing 120-row bars contain the 20-session warm-up even though
            # their metadata start marks the former 60-day reporting window.
            bars = p.get('bars') if isinstance(p, dict) else None
            if not bars:
                bars = Q.fetch_amount_bars(code, missing[0], quality['series'][-1]['date'])
                Q.atomic_json(path, {'start': missing[0], 'through': quality['series'][-1]['date'], 'bars': bars})
            if [r['date'] for r in bars] != sorted({r['date'] for r in bars}):
                raise ValueError(code + ': invalid cached amounts')
            for row in bars:
                number(row['amountYuan'], positive=False)
                number(row['close'])
                if row['amountYuan'] < 0:
                    raise ValueError(code + ': negative actual amount')
            return code, bars
        with ThreadPoolExecutor(max_workers=workers) as pool:
            prices = dict(pool.map(stock, codes))
        verified = Q.reconcile_missing_sessions(universes, prices, missing[0], missing[-1], workers, cache_dir)
        for d in missing:
            row = Q.build_day(d, universes[d], prices, verified_nontrading=verified)
            by_date[d] = {'date': d, 'amountYuan': row['totalAmountYuan']}
        print(f'Actual amount warm-up reconstructed: {len(missing)} dates, reused {len(codes)} cached securities', flush=True)
    result = [by_date[d] for d in required]
    validate_rows(result, 'amountYuan', 80)
    for d, q in quality_rows.items():
        if by_date[d]['amountYuan'] != q['totalAmountYuan']:
            raise ValueError('Quality amount mismatch: ' + d)
    return result


def parse_margin(p, market):
    raw = (p.get('result') or {}).get('data')
    if not p.get('success') or not isinstance(raw, list) or len(raw) < 90:
        raise ValueError('Incomplete margin history')
    result = {}
    for r in raw:
        d = day(r['DIM_DATE'])
        if str(r.get('SCDM', '')).zfill(3) != market or d in result:
            raise ValueError('Wrong/duplicate margin market')
        financing = number(r['RZYE'])
        combined = number(r['RZRQYE'])
        lending = number(r['RQYE'], positive=False)
        if lending < 0 or abs(financing + lending - combined) > 2:
            raise ValueError('Inconsistent margin components')
        result[d] = {'financing': financing, 'combined': combined}
    return result


def fetch_margin(required, dates, optional_latest=None):
    def fetch_market(market):
        params = {'reportName': 'RPTA_WEB_RZRQ_LSSH', 'columns': 'DIM_DATE,SCDM,RZYE,RQYE,RZRQYE',
                  'pageSize': 180, 'pageNumber': 1, 'sortColumns': 'DIM_DATE', 'sortTypes': -1,
                  'filter': f'(SCDM="{market}")', 'source': 'WEB', 'client': 'WEB'}
        return parse_margin(Q.get_json('https://datacenter-web.eastmoney.com/api/data/v1/get?' + urlencode(params)), market)
    with ThreadPoolExecutor(max_workers=2) as pool:
        sh, sz = list(pool.map(fetch_market, ('007', '001')))
    if any(d not in sh or d not in sz for d in required):
        raise ValueError('Missing Shanghai/Shenzhen margin trading session')
    # Today's financing report is published on the next session. The model
    # needs D-1, so an unpublished D must never prevent D's closing score.
    if (optional_latest and optional_latest not in required and optional_latest in sh
            and optional_latest in sz and next_session(optional_latest, dates)):
        required = required + [optional_latest]
    result = [{'date': d, 'balanceYuan': sh[d]['financing'] + sz[d]['financing'],
               'combinedBalanceYuan': sh[d]['combined'] + sz[d]['combined'],
               'availableOn': next_session(d, dates)} for d in required]
    return validate_rows(result, 'balanceYuan', 90)


def etf_history(required, dates, core, old, workers=4):
    funds = {code: {} for code in FUNDS}
    for payload in ((old or {}).get('etf', {}), core):
        raw = payload.get('funds')
        if not isinstance(raw, list) or {f.get('code') for f in raw} != set(FUNDS):
            if payload:
                raise ValueError('Wrong ETF representative products')
            continue
        for fund in raw:
            for row in validate_rows(fund['series'], 'shares'):
                shares = number(row['shares'])
                if not shares.is_integer():
                    raise ValueError('Fractional ETF shares')
                funds[fund['code']][row['date']] = int(shares)
    missing = [d for d in required if any(d not in f for f in funds.values())]
    def fetch(d):
        rows = E.fetch_shares(d)
        if set(rows) != set(FUNDS):
            raise ValueError('Incomplete ETF date: ' + d)
        return d, rows
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for d, values in pool.map(fetch, missing):
            for code, row in values.items():
                funds[code][d] = row['shares']
    return [{'code': code, 'label': next(f['label'] for f in E.FUNDS if f['code'] == code),
             'series': [{'date': d, 'shares': funds[code][d], 'availableOn': next_session(d, dates)} for d in required]}
            for code in FUNDS]


def validate_payload(p, targets=None):
    if p.get('schemaVersion') != 1 or p.get('scope') != '沪深A股':
        raise ValueError('Invalid support schema')
    updated = dt.datetime.fromisoformat(p['updatedAt'])
    if updated.tzinfo is None:
        raise ValueError('Ambiguous update time')
    dates = p['calendar']
    if len(dates) < 90 or dates != sorted(set(dates)):
        raise ValueError('Invalid support calendar')
    for d in dates:
        day(d)
    amount = validate_rows(p['amountHistory']['series'], 'amountYuan', 80)
    margin = validate_rows(p['margin']['series'], 'balanceYuan', 90)
    funds = p['etf']['funds']
    if {f['code'] for f in funds} != set(FUNDS):
        raise ValueError('Wrong ETF support coverage')
    for rows, key in [(margin, 'balanceYuan')] + [(f['series'], 'shares') for f in funds]:
        validate_rows(rows, key, 65)
        for row in rows:
            if row['date'] not in dates or row.get('availableOn') != next_session(row['date'], dates):
                raise ValueError('Invalid lagged availability mapping')
    if targets:
        first, end = dates.index(targets[0]), dates.index(targets[-1])
        if [r['date'] for r in amount] != dates[first - 20:end + 1]:
            raise ValueError('Incomplete twenty-day amount warm-up')
        needed = dates[first - 6:end]
        for fund in funds:
            if not set(needed) <= {r['date'] for r in fund['series']}:
                raise ValueError('Missing five-day ETF warm-up')
    latest = max(r['date'] for r in amount)
    cn = updated.astimezone(TZ)
    if latest > cn.date().isoformat() or (latest == cn.date().isoformat() and cn.time().replace(tzinfo=None) < dt.time(15, 10)):
        raise ValueError('Uncompleted source session')
    return p


def refresh(input_dir, cache_dir, output, workers=6, now=None):
    now = now or dt.datetime.now(TZ)
    now = now.astimezone(TZ)
    input_dir, output = Path(input_dir), Path(output)
    quality = Q.validate_payload(json.loads((input_dir / 'market_quality.json').read_text()))
    core_etf = json.loads((input_dir / 'etf_shares.json').read_text())
    dates, closed = calendar(now)
    targets = [r['date'] for r in quality['series']]
    # The upstream close products finish at different times. Keep an aligned
    # 60-session core ending on either of the last two completed sessions;
    # never manufacture a new date while another source is still running.
    last = closed.index(targets[-1]) if targets[-1] in closed else -1
    if (last < len(closed) - 2 or last < 59
            or targets != closed[last - 59:last + 1]):
        raise ValueError('Quality daily history is stale or not aligned to the exchange calendar')
    first, end = dates.index(targets[0]), dates.index(targets[-1])
    if first < 31:
        raise ValueError('Insufficient warm-up calendar')
    old = read_existing(output)
    if old and old['amountHistory']['series'][-1]['date'] > targets[-1]:
        raise ValueError('Reject latest source date regression')
    amount_dates = dates[first - 20:end + 1]
    margin_dates = dates[first - 31:end]
    etf_dates = dates[first - 6:end]
    # Include D only when it is already disclosed in all three core series.
    # Never query a not-yet-cleared D as though the model requires it.
    core_funds = core_etf.get('funds') or []
    if (len(core_funds) == 3 and {f.get('code') for f in core_funds} == set(FUNDS)
            and all(any(r.get('date') == targets[-1] for r in f.get('series', [])) for f in core_funds)):
        etf_dates.append(targets[-1])
    amount = warmup_amounts(amount_dates, quality, old, cache_dir, workers)
    margin = fetch_margin(margin_dates, dates, optional_latest=targets[-1])
    funds = etf_history(etf_dates, dates, core_etf, old, min(workers, 4))
    result = {'schemaVersion': 1, 'updatedAt': now.isoformat(timespec='seconds'), 'scope': '沪深A股',
              'source': SOURCE, 'methodology': METHOD, 'calendar': dates,
              'amountHistory': {'source': Q.SOURCE, 'sourceUrl': 'https://data.eastmoney.com/gzfx/list.html',
                                'series': amount},
              'margin': {'metric': 'RZYE', 'label': '沪深两市融资余额',
                         'scope': '沪市及深市融资标的证券合计，含交易所融资标的基金，不含北交所与融券余额',
                         'source': '东方财富RPTA_WEB_RZRQ_LSSH：SCDM=007与001分别取得后按同日相加',
                         'sourceUrl': 'https://data.eastmoney.com/rzrq/total.html', 'series': margin},
              'etf': {'coverage': '3只代表ETF，非全市场合计', 'source': '上交所清算后ETF份额',
                      'sourceUrl': E.SSE_PAGE, 'funds': funds}}
    validate_payload(result, targets)
    atomic_json(output, result)
    print(json.dumps({'latest': targets[-1], 'amountDays': len(amount), 'amountFirst': amount[0]['date'],
                      'marginDays': len(margin), 'marginLatest': margin[-1],
                      'etfDays': len(funds[0]['series']), 'etfFirst': funds[0]['series'][0]['date']}, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/market-quality')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/market_heat_support.json')
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    try:
        refresh(args.input_dir, args.cache_dir, args.output, args.workers)
    except Exception as exc:
        print('Market-heat support refresh failed; existing file retained: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
