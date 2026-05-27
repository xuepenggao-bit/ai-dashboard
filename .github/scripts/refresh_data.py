#!/usr/bin/env python3
"""
Refresh Xueqiu hot stocks and portfolio Top5 sentiment data.
Outputs: data/xq_hot.json  data/xq_sentiment.json
"""
import os, json, time, datetime, re, requests

XQ_TOKEN     = os.environ.get('XQ_TOKEN', '')
GITHUB_TOKEN  = os.environ.get('GITHUB_TOKEN', '')   # 自动注入，无需手动添加 Secret

HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer':         'https://xueqiu.com/',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin':          'https://xueqiu.com',
}
if XQ_TOKEN:
    HEADERS['Cookie'] = f'xq_a_token={XQ_TOKEN}; xq_is_login=1; u=111'

POS_WORDS = ['看多','买入','值得买','上涨','利好','突破','强势','增持','超预期','大涨',
             '新高','建仓','加仓','推荐','机会','低吸','看好','有望','涨停','放量','优质',
             '高成长','底部','翻倍','增长','分红','回调买','低估','绩优','主升浪','继续持有']
NEG_WORDS = ['看空','卖出','下跌','利空','破位','弱势','减持','不及预期','大跌','新低',
             '出局','减仓','风险','警惕','跌停','套牢','亏损','压力','见顶','悲观',
             '泡沫','担忧','不确定','跌破','暴跌','高估','缩量','割肉','筑顶','主跌浪']

# ── 工具函数 ────────────────────────────────────────────────────

def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')

def clean_html(html):
    if not html:
        return ''
    t = re.sub(r'<[^>]+>', '', html)
    for src, dst in [('&lt;','<'),('&gt;','>'),('&amp;','&'),('&quot;','"'),('&#\d+;','')]:
        t = re.sub(src, dst, t)
    return re.sub(r'\s+', ' ', t).strip()

def score_sentiment(text):
    if not text: return 0
    s = 0
    for w in POS_WORDS:
        if w in text: s += 1
    for w in NEG_WORDS:
        if w in text: s -= 1
    return s

def xq_symbol(sk):
    mkt  = sk.get('mkt', '')
    code = str(sk.get('code', ''))
    if mkt == 'HK':
        return 'HK' + code.zfill(5)
    return mkt + code

# ── 热股榜 ──────────────────────────────────────────────────────

def fetch_hot_stocks():
    url = ('https://stock.xueqiu.com/v5/stock/screener/quote/list.json'
           '?market=CN&order=desc&order_by=value&page=1&size=20&type=hot_1h')
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        raw = r.json().get('data', {}).get('list', [])
        return [{'rank': i+1,
                 'symbol':  s.get('symbol',''),
                 'name':    s.get('name',''),
                 'current': s.get('current'),
                 'percent': s.get('percent'),
                 'value':   s.get('value'),
                 'chg':     s.get('chg')} for i, s in enumerate(raw)]
    except Exception as e:
        print(f'  [热股榜] 获取失败: {e}')
        return []

# ── 讨论抓取 ───────────────────────────────────────────────────
# 多接口备用：v4 timeline > query/v1 search > v4 user_timeline

def _fetch_page(url, symbol, page_num):
    """抓单页，返回帖子列表；任何错误返回 None。"""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        print(f'  [{symbol}] 接口 HTTP {r.status_code}  url={url[:80]}')
        if r.status_code in (401, 403):
            print(f'  [{symbol}] ⚠️  认证失败（{r.status_code}），XQ_TOKEN 可能已过期')
            return None
        r.raise_for_status()
        data = r.json()
        # 兼容多种响应结构
        lst = (data.get('list')
               or data.get('statuses')
               or data.get('items')
               or (data.get('data') or {}).get('list')
               or [])
        print(f'  [{symbol}] 第{page_num}页返回 {len(lst)} 条，keys={list(data.keys())}')
        return lst
    except Exception as e:
        print(f'  [{symbol}] 请求异常: {type(e).__name__}: {e}')
        return None


def fetch_stock_posts(symbol, pages=3):
    posts = []

    # 接口1：v4 timeline（不需要登录，公开数据）
    for page in range(1, pages + 1):
        url = (f'https://xueqiu.com/v4/statuses/search.json'
               f'?symbol={symbol}&type=1&page={page}&count=20&_={int(time.time()*1000)}')
        lst = _fetch_page(url, symbol, page)
        if lst is None:
            break
        items = lst
        # v4 返回的每条可能嵌套在 'data' 或 'statuses' 字段里
        if lst and isinstance(lst[0], dict) and 'statuses' in lst[0]:
            items = [s for entry in lst for s in entry.get('statuses', [])]
        posts.extend(items)
        if len(items) < 15:
            break
        if page < pages:
            time.sleep(0.4)

    if posts:
        return posts

    # 接口2：query/v1 search（需要 XQ_TOKEN）
    print(f'  [{symbol}] 接口1无结果，尝试接口2…')
    for page in range(1, pages + 1):
        url = (f'https://xueqiu.com/query/v1/symbol/search/status'
               f'?symbol={symbol}&page={page}&size=20&type=status&_={int(time.time()*1000)}')
        lst = _fetch_page(url, symbol, page)
        if lst is None:
            break
        posts.extend(lst)
        if len(lst) < 20:
            break
        if page < pages:
            time.sleep(0.4)

    return posts

# ── 情感分析（关键词） ─────────────────────────────────────────

def keyword_analyze(posts):
    scored = []
    for p in posts:
        raw  = p.get('description') or p.get('text') or ''
        txt  = clean_html(raw)
        disp = txt[:55]
        eng  = (p.get('like_count') or 0) * 3 + (p.get('reply_count') or 0) * 2
        scored.append({'disp': disp, 'score': score_sentiment(txt), 'eng': eng})

    pos = [x['disp'] for x in sorted(
               [x for x in scored if x['score'] > 0], key=lambda x: -x['eng'])[:3]
           if x['disp']]
    neg = [x['disp'] for x in sorted(
               [x for x in scored if x['score'] < 0], key=lambda x: -x['eng'])[:3]
           if x['disp']]

    # 若无明显正面，取互动最高的 2 条补充
    if not pos and scored:
        pos = [x['disp'] for x in sorted(scored, key=lambda x: -x['eng'])[:2] if x['disp']]

    return pos, neg, len(posts)

# ── 情感分析（GitHub Models / gpt-4o-mini） ───────────────────
# 使用 GitHub Actions 自动注入的 GITHUB_TOKEN，无需额外 Secret

def ai_analyze(name, symbol, posts):
    """调用 GitHub Models API（gpt-4o-mini）做语义摘要，失败时回退关键词分析。"""
    if not GITHUB_TOKEN:
        print(f'  [AI] GITHUB_TOKEN 不可用，回退关键词分析')
        return keyword_analyze(posts)

    texts = []
    for p in posts[:40]:
        raw = p.get('description') or p.get('text') or ''
        txt = clean_html(raw)[:120]
        if txt:
            texts.append(txt)

    if not texts:
        return [], [], len(posts)

    sample = '\n'.join(f'{i+1}. {t}' for i, t in enumerate(texts[:30]))
    prompt = (f'以下是雪球上关于{name}（{symbol}）的最新讨论帖子（共{len(texts)}条精选）：\n\n'
              f'{sample}\n\n'
              f'请从中提取：\n'
              f'1. 最具代表性的3条正面/看多观点（简洁概括，每条不超过40字）\n'
              f'2. 最具代表性的3条负面/看空观点（简洁概括，每条不超过40字）\n\n'
              f'如果某方向观点不足3条，可以少于3条。如果某方向完全没有，返回空列表。\n\n'
              f'请以JSON格式回复（不要有其他文字）：\n'
              f'{{"pos": ["...", "...", "..."], "neg": ["...", "...", ...]}}')

    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={
                'Authorization': f'Bearer {GITHUB_TOKEN}',
                'Content-Type':  'application/json',
            },
            json={
                'model':       'gpt-4o-mini',
                'messages':    [{'role': 'user', 'content': prompt}],
                'max_tokens':  500,
                'temperature': 0.3,
            },
            timeout=30,
        )
        r.raise_for_status()
        raw_resp = r.json()['choices'][0]['message']['content'].strip()
        m = re.search(r'\{.*\}', raw_resp, re.DOTALL)
        if m:
            j = json.loads(m.group())
            pos = [x for x in j.get('pos', []) if x and x != '...'][:3]
            neg = [x for x in j.get('neg', []) if x and x != '...'][:3]
            return pos, neg, len(posts)
    except Exception as e:
        print(f'  [AI] GitHub Models 调用失败: {e}，回退关键词分析')

    return keyword_analyze(posts)

# ── 读取组合 ───────────────────────────────────────────────────

def load_portfolio():
    # 脚本在 .github/scripts/，仓库根在 ../..
    path = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'portfolio.json'))
    if not os.path.exists(path):
        print(f'  [组合] portfolio.json 不存在: {path}')
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def get_top5(portfolio):
    all_stocks = []
    for sec in portfolio.get('sectors', []):
        for sk in sec.get('stocks', []):
            if (sk.get('w') or 0) > 0:
                all_stocks.append(sk)
    all_stocks.sort(key=lambda x: -(x.get('w') or 0))
    return all_stocks[:5]

# ── 主程序 ─────────────────────────────────────────────────────

def main():
    os.makedirs('data', exist_ok=True)
    ts = now_ts()
    print(f'\n=== Xueqiu 数据刷新  {ts} ===\n')

    # 1. 热股榜
    print('📊 获取雪球热股榜…')
    hot_list = fetch_hot_stocks()
    with open('data/xq_hot.json', 'w', encoding='utf-8') as f:
        json.dump({'ts': ts, 'list': hot_list}, f, ensure_ascii=False, indent=2)
    print(f'   ✅ {len(hot_list)} 只 → data/xq_hot.json')

    # 2. 权重股舆情
    print('\n🔍 获取 Top5 权重股舆情…')
    portfolio = load_portfolio()
    if not portfolio:
        print('   ⚠️  无法读取 portfolio.json，跳过舆情分析')
        with open('data/xq_sentiment.json', 'w', encoding='utf-8') as f:
            json.dump({'ts': ts, 'stocks': []}, f, ensure_ascii=False)
        return

    top5 = get_top5(portfolio)
    if not top5:
        print('   ⚠️  portfolio 中无权重股')
        with open('data/xq_sentiment.json', 'w', encoding='utf-8') as f:
            json.dump({'ts': ts, 'stocks': []}, f, ensure_ascii=False)
        return

    use_ai = bool(GITHUB_TOKEN)
    print(f'   分析方式: {"GitHub Models / gpt-4o-mini" if use_ai else "关键词匹配"}')

    stocks_result = []
    for sk in top5:
        sym  = xq_symbol(sk)
        name = sk.get('name', sym)
        w    = sk.get('w', 0)
        print(f'\n   [{sym}] {name} ({w}%) - 抓取讨论…')
        posts = fetch_stock_posts(sym)
        print(f'   [{sym}] 获取 {len(posts)} 条')

        if use_ai:
            pos, neg, total = ai_analyze(name, sym, posts)
        else:
            pos, neg, total = keyword_analyze(posts)

        print(f'   [{sym}] 🟢 正面 {len(pos)} 条  🔴 负面 {len(neg)} 条')
        stocks_result.append({
            'code': sym, 'name': name, 'w': w,
            'pos': pos, 'neg': neg, 'total': total,
        })
        time.sleep(0.5)

    with open('data/xq_sentiment.json', 'w', encoding='utf-8') as f:
        json.dump({'ts': ts, 'stocks': stocks_result}, f, ensure_ascii=False, indent=2)
    print(f'\n✅ 完成 → data/xq_sentiment.json  ({len(stocks_result)} 只股票  {ts})\n')

if __name__ == '__main__':
    main()
