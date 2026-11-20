#!/usr/bin/env python3
"""Fixed AI equity samples versus local broad benchmarks; completed closes only.

This is a representative, equal-initial-capital price sample, not an official
sector index or total-return portfolio. No FX, dividends, costs or price targets.
An optional sample failure cannot erase a previously valid market snapshot.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/ai_global_market_prices.json'
LIMIT = 120
MINIMUM = 61
CN = ZoneInfo('Asia/Shanghai')
MARKETS = [
    {'id': 'us', 'name': '美国', 'currency': 'USD', 'timezone': 'America/New_York', 'closeMinute': 980,
     'benchmark': ('.INX', '标普 500', 'naver_index'),
     'stocks': [('NVDA', '英伟达', 'tencent_us'), ('AVGO', '博通', 'tencent_us'),
                ('MSFT', '微软', 'tencent_us'), ('GOOGL', 'Alphabet A', 'tencent_us'), ('META', 'Meta', 'tencent_us')]},
    {'id': 'kr', 'name': '韩国', 'currency': 'KRW', 'timezone': 'Asia/Seoul', 'closeMinute': 945,
     'benchmark': ('KOSPI', '韩国综合指数', 'naver_kospi'),
     'stocks': [('005930', '三星电子', 'naver_kr'), ('000660', 'SK 海力士', 'naver_kr')]},
    {'id': 'tw', 'name': '台湾', 'currency': 'TWD', 'timezone': 'Asia/Taipei', 'closeMinute': 840,
     'benchmark': ('.TWII', '台湾加权指数', 'naver_index'),
     'stocks': [('2330', '台积电', 'finmind_tw'), ('2454', '联发科', 'finmind_tw'), ('2382', '广达', 'finmind_tw')]},
    {'id': 'cn', 'name': '中国 A 股', 'currency': 'CNY', 'timezone': 'Asia/Shanghai', 'closeMinute': 910,
     'benchmark': ('sh000300', '沪深 300', 'tencent_cn'),
     'stocks': [('sz300308', '中际旭创', 'tencent_cn'), ('sz300502', '新易盛', 'tencent_cn'),
                ('sz002463', '沪电股份', 'tencent_cn'), ('sz002916', '深南电路', 'tencent_cn')]},
]
METHOD = ('各市场采用固定代表公司样本，按所选窗口起点各投入等额本币，持有不再平衡；'
          '曲线为各股收盘价格相对起点涨跌幅的算术平均，不是官方AI行业指数。'
          '宽基以同一日期起点归一。仅比较全部样本与基准共有的已收盘交易日；'
          '不计股息、汇率和交易成本，不外推缺失交易日。')


def get_json(url):
    error = None
    for _ in range(2):
        try:
            req = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
                                       'Referer': 'https://finance.naver.com/' if 'naver' in url else 'https://gu.qq.com/'})
            with urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            error = exc
    raise RuntimeError(str(error))


def valid_date(value):
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError('missing ISO date')
    date = dt.date.fromisoformat(value)
    if date.isoformat() != value or date.weekday() >= 5:
        raise ValueError('invalid or weekend close date')
    return date


def close_cutoff(market, now):
    local = now.astimezone(ZoneInfo(market['timezone']))
    date = local.date()
    if local.hour * 60 + local.minute < market['closeMinute']:
        date -= dt.timedelta(days=1)
    return date


def validate_series(rows, cutoff, minimum=MINIMUM):
    if not isinstance(rows, list) or len(rows) < minimum:
        raise ValueError('insufficient closing history')
    result, previous = [], None
    for row in rows:
        date = valid_date(row.get('date'))
        close = row.get('close')
        if date > cutoff or previous and date <= previous:
            raise ValueError('future, duplicate or unordered daily close')
        if type(close) not in (float, int) or not math.isfinite(close) or close <= 0:
            raise ValueError('non-numeric, missing or nonpositive close')
        result.append({'date': date.isoformat(), 'close': close})
        previous = date
    if (cutoff - previous).days > 10:
        raise ValueError('closing feed is too old for the current review')
    return result[-LIMIT:]


def parse_tencent(payload, symbol, cutoff):
    data = (payload.get('data') or {}).get(symbol)
    if payload.get('code') != 0 or not isinstance(data, dict):
        raise ValueError('Tencent symbol response mismatch')
    raw = data.get('day') or data.get('qfqday')
    if not isinstance(raw, list):
        raise ValueError('Tencent daily bars missing')
    rows = []
    for row in raw:
        if not isinstance(row, list) or len(row) < 3:
            raise ValueError('malformed Tencent daily bar')
        date = valid_date(row[0])
        if date > cutoff:
            continue
        rows.append({'date': row[0], 'close': float(row[2])})
    return validate_series(rows, cutoff)


def parse_naver(payload, symbol, cutoff):
    if payload.get('code') != symbol or not isinstance(payload.get('priceInfos'), list):
        raise ValueError('Naver symbol response mismatch')
    rows = []
    for row in payload['priceInfos']:
        raw = str(row.get('localDate', ''))
        if len(raw) != 8 or not raw.isdigit():
            raise ValueError('Naver missing date')
        date = raw[:4] + '-' + raw[4:6] + '-' + raw[6:]
        if valid_date(date) > cutoff:
            continue
        rows.append({'date': date, 'close': row.get('closePrice')})
    return validate_series(rows, cutoff)


def parse_finmind(payload, symbol, cutoff):
    if payload.get('status') != 200 or not isinstance(payload.get('data'), list):
        raise ValueError('FinMind response missing')
    rows = []
    for row in payload['data']:
        if str(row.get('stock_id')) != symbol:
            raise ValueError('FinMind symbol response mismatch')
        if valid_date(row.get('date')) > cutoff:
            continue
        rows.append({'date': row['date'], 'close': row.get('close')})
    return validate_series(rows, cutoff)


def fetch_security(security, market, now, fetcher=get_json):
    symbol, name, provider = security
    cutoff = close_cutoff(market, now)
    if provider.startswith('tencent'):
        code = 'us' + symbol + '.OQ' if provider == 'tencent_us' else symbol
        # The plain fqkline endpoint accepts the exchange-qualified US code and
        # returns unadjusted day bars. usfqkline with qfq would change the basis.
        url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?' + urlencode({'param': f'{code},day,,,140,'})
        rows = parse_tencent(fetcher(url), code, cutoff)
        source = '腾讯财经收盘日线'
    elif provider.startswith('naver'):
        category = 'foreign/index' if provider == 'naver_index' else 'domestic/index' if provider == 'naver_kospi' else 'domestic/item'
        url = f'https://api.stock.naver.com/chart/{category}/{symbol}?periodType=dayCandle'
        rows = parse_naver(fetcher(url), symbol, cutoff)
        source = 'Naver Finance 收盘日线'
    elif provider == 'finmind_tw':
        url = 'https://api.finmindtrade.com/api/v4/data?' + urlencode({'dataset': 'TaiwanStockPrice', 'data_id': symbol,
              'start_date': (cutoff - dt.timedelta(days=220)).isoformat(), 'end_date': cutoff.isoformat()})
        rows = parse_finmind(fetcher(url), symbol, cutoff)
        source = 'FinMind 台湾股票日收盘价（TWSE历史行情整理）'
    else:
        raise ValueError('unknown price provider')
    return {'symbol': symbol, 'name': name, 'source': source, 'sourceUrl': url, 'series': rows}


def common_dates(market):
    securities = [market['benchmark'], *market['stocks']]
    return sorted(set.intersection(*({row['date'] for row in security['series']} for security in securities)))


def finish_market(definition, securities, now):
    market = {k: definition[k] for k in ('id', 'name', 'currency', 'timezone')}
    market.update({'benchmark': securities[0], 'stocks': securities[1:], 'updatedAt': now.isoformat(timespec='seconds'),
                   'status': 'ok', 'sampleNote': '固定代表公司样本，非全市场或官方行业指数；成分权重在窗口起点等额。'})
    dates = common_dates(market)
    if len(dates) < MINIMUM:
        raise ValueError('insufficient common sample/benchmark sessions')
    market['asOf'] = dates[-1]
    market['commonSessions'] = len(dates)
    market['priceBasis'] = '本币收盘价格收益，不含现金股息；未复权日线，窗口内若发生拆股须先复核再比较。'
    return market


def valid_previous_market(market, definition, now):
    """Only a previously complete, internally coherent sample may be retained."""
    try:
        if market.get('id') != definition['id'] or market.get('currency') != definition['currency']:
            return False
        published = dt.datetime.fromisoformat(market['updatedAt'])
        if published.tzinfo is None or published > now + dt.timedelta(minutes=2):
            return False
        actual = [market['benchmark'], *market['stocks']]
        expected = [definition['benchmark'], *definition['stocks']]
        if len(actual) != len(expected) or [s['symbol'] for s in actual] != [s[0] for s in expected]:
            return False
        cutoff = close_cutoff(definition, min(published, now))
        for security in actual:
            if not str(security.get('sourceUrl', '')).startswith('https://'):
                return False
            validate_series(security['series'], cutoff)
        dates = common_dates(market)
        return len(dates) >= MINIMUM and market['asOf'] == dates[-1]
    except (KeyError, TypeError, ValueError):
        return False


def refresh(previous=None, now=None, fetcher=get_json):
    now = now or dt.datetime.now(CN)
    definitions = {m['id']: m for m in MARKETS}
    old_markets = {m['id']: m for m in (previous or {}).get('markets', [])
                   if isinstance(m, dict) and m.get('id') in definitions
                   and valid_previous_market(m, definitions[m['id']], now)}
    results, errors = {}, []
    jobs = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for market in MARKETS:
            for i, security in enumerate([market['benchmark'], *market['stocks']]):
                jobs[pool.submit(fetch_security, security, market, now, fetcher)] = (market['id'], i)
        for job in as_completed(jobs):
            market_id, i = jobs[job]
            try:
                results.setdefault(market_id, {})[i] = job.result()
            except Exception as exc:
                errors.append({'market': market_id, 'securityIndex': i, 'message': str(exc)[:200]})
    markets = []
    for definition in MARKETS:
        market_id = definition['id']
        fetched = results.get(market_id, {})
        try:
            if len(fetched) != len(definition['stocks']) + 1:
                raise ValueError('incomplete market sample')
            market = finish_market(definition, [fetched[i] for i in range(len(fetched))], now)
            old = old_markets.get(market_id)
            if old and market['asOf'] < old['asOf']:
                raise ValueError('refusing a market date regression')
            markets.append(market)
        except Exception as exc:
            errors.append({'market': market_id, 'message': str(exc)})
            old = old_markets.get(market_id)
            if old:
                markets.append({**old, 'status': 'retained', 'refreshError': str(exc)})
    if len(markets) != len(MARKETS):
        raise ValueError('No complete four-market snapshot; existing file left intact: ' + json.dumps(errors, ensure_ascii=False))
    return {'schemaVersion': 1, 'updatedAt': now.isoformat(timespec='seconds'), 'methodology': METHOD,
            'status': 'partial' if errors else 'ok', 'markets': markets, 'errors': errors,
            'notes': ['四地交易时区和休市日不同，不能把不同交易日涨跌当作同步回报。',
                      '代表样本不是投资组合建议，未使用估值模型或一致预期。行情刷新时间不等于定性研究更新日期。']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    previous = json.loads(args.output.read_text()) if args.output.exists() else None
    try:
        result = refresh(previous)
    except Exception as exc:
        print('AI cross-market prices refresh failed: ' + str(exc))
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_suffix('.json.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temp.replace(args.output)
    print(json.dumps({'status': result['status'], 'markets': [{k: m[k] for k in ('id', 'asOf', 'commonSessions')} for m in result['markets']], 'errors': result['errors']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
