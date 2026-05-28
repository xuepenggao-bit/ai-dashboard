#!/usr/bin/env python3
"""
Refresh Xueqiu hot stocks and portfolio Top5 sentiment data.
Sentiment pipeline:
  1. Xueqiu user_timeline (requires XQ_TOKEN; GitHub Actions IPs are bot-detected)
  2. Yahoo Finance news search (globally accessible, no auth needed; English headlines
     are handled by GPT-4o-mini which summarises them into Chinese pos/neg points)
  3. Keyword-based fallback on whatever posts are available

Outputs: data/xq_hot.json  data/xq_sentiment.json
"""
import os, json, time, datetime, re, requests

XQ_TOKEN     = os.environ.get('XQ_TOKEN', '')
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')

UA_BROWSER = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
              'AppleWebKit/537.36 (KHTML, like Gecko) '
              'Chrome/124.0.0.0 Safari/537.36')

POS_WORDS = ['看多','买入','值得买','上涨','利好','突破','强势','增持','超预期','大涨',
             '新高','建仓','加仓','推荐','机会','低吸','看好','有望','涨停','放量','优质',
             '高成长','底部','翻倍','增长','分红','回调买','低估','绩优','主升浪','继续持有']
NEG_WORDS = ['看空','卖出','下跌','利空','破位','弱势','减持','不及预期','大跌','新低',
             '出局','减仓','风险','警惕','跌停','套牢','亏损','压力','见顶','悲观',
             '泡沫','担忧','不确定','跌破','暴跌','高估','缩量','割肉','筑顶','主跌浪']

# ── 工具 ────────────────────────────────────────────────────────

def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')

def clean_html(html):
    if not html: return ''
    t = re.sub(r'<[^>]+>', '', html)
    for s, d in [('&lt;','<'),('&gt;','>'),('&amp;','&'),('&quot;','"')]:
        t = t.replace(s, d)
    return re.sub(r'\s+', ' ', t).strip()

def score_sentiment(text):
    if not text: return 0
    return sum(1 for w in POS_WORDS if w in text) - sum(1 for w in NEG_WORDS if w in text)

def xq_symbol(sk):
    mkt, code = sk.get('mkt',''), str(sk.get('code',''))
    return ('HK' + code.zfill(5)) if mkt == 'HK' else (mkt + code)

def _em_code(symbol):
    """SH600519 → '600519'  SZ300394 → '300394'  HK02476 → '02476'"""
    if symbol.startswith('HK'):
        return symbol[2:]          # keep leading zeros for HK
    return re.sub(r'^[A-Z]+', '', symbol)

def _yahoo_symbol(symbol):
    """SH600519 → '600519.SS'  SZ300394 → '300394.SZ'  HK02476 → '2476.HK'"""
    if symbol.startswith('HK'):
        code = symbol[2:].lstrip('0') or '0'
        return f'{code}.HK'
    m = re.match(r'^(SH|SZ)(\d+)$', symbol)
    if m:
        suffix = 'SS' if m.group(1) == 'SH' else 'SZ'
        return f'{m.group(2)}.{suffix}'
    return symbol

# ── Xueqiu Session（预热首页，绕过 bot 检测） ────────────────────

_xq_sess = None

def xq_session():
    global _xq_sess
    if _xq_sess:
        return _xq_sess
    s = requests.Session()
    s.headers.update({
        'User-Agent': UA_BROWSER,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://xueqiu.com/',
        'Origin':  'https://xueqiu.com',
    })
    try:
        r = s.get('https://xueqiu.com/', timeout=12)
        print(f'  [XQ-Session] 首页预热 HTTP {r.status_code}，'
              f'cookies: {list(s.cookies.keys())}')
    except Exception as e:
        print(f'  [XQ-Session] 首页预热失败: {e}')
    if XQ_TOKEN:
        s.cookies.set('xq_a_token',  XQ_TOKEN, domain='.xueqiu.com')
        s.cookies.set('xq_is_login', '1',       domain='.xueqiu.com')
        print('  [XQ-Session] 已注入 xq_a_token')
    _xq_sess = s
    return s

def _is_html(r):
    ct = r.headers.get('Content-Type', '')
    return 'html' in ct or r.text.lstrip().startswith('<')

# ── 热股榜（Xueqiu） ────────────────────────────────────────────

def fetch_hot_stocks():
    url = ('https://stock.xueqiu.com/v5/stock/screener/quote/list.json'
           '?market=CN&order=desc&order_by=value&page=1&size=20&type=hot_1h')
    try:
        r = xq_session().get(url, timeout=15)
        print(f'  [热股榜] HTTP {r.status_code}')
        r.raise_for_status()
        raw = r.json().get('data', {}).get('list', [])
        return [{'rank':i+1,'symbol':s.get('symbol',''),'name':s.get('name',''),
                 'current':s.get('current'),'percent':s.get('percent'),
                 'value':s.get('value'),'chg':s.get('chg')} for i,s in enumerate(raw)]
    except Exception as e:
        print(f'  [热股榜] 失败: {e}')
        return []

# ── 情感来源 1：Xueqiu 用户时间线 ───────────────────────────────

def _xueqiu_posts(symbol, pages=3):
    """尝试雪球 user_timeline（GitHub Actions IP 通常被 Bot 检测拦截）。"""
    posts = []
    sess = xq_session()
    for page in range(1, pages + 1):
        url = (f'https://xueqiu.com/v4/statuses/user_timeline.json'
               f'?page={page}&count=20&symbol={symbol}&_={int(time.time()*1000)}')
        try:
            r = sess.get(url, timeout=15)
            print(f'  [{symbol}] XQ timeline 第{page}页 HTTP {r.status_code}')
            if r.status_code in (401, 403):
                break
            r.raise_for_status()
            if _is_html(r):
                print(f'  [{symbol}] XQ 返回 HTML（Bot 检测），停止')
                break
            data = r.json()
            lst = data.get('statuses', data.get('list', []))
            posts.extend(lst)
            if len(lst) < 15:
                break
        except Exception as e:
            print(f'  [{symbol}] XQ 第{page}页异常: {e}')
            break
        if page < pages:
            time.sleep(0.5)
    return posts

# ── 情感来源 2：Yahoo Finance 新闻（全球可达，无需认证） ─────────

def _yahoo_news_posts(symbol):
    """
    Yahoo Finance 新闻搜索接口（query2.finance.yahoo.com）。
    GitHub Actions Azure IP 可正常访问，无需登录。
    新闻标题多为英文，由后续 AI 分析归纳为中文观点。
    """
    ys = _yahoo_symbol(symbol)
    url = (f'https://query2.finance.yahoo.com/v1/finance/search'
           f'?q={ys}&newsCount=20&quotesCount=0&enableFuzzyQuery=false')
    hdrs = {
        'User-Agent': UA_BROWSER,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    }
    try:
        r = requests.get(url, headers=hdrs, timeout=15)
        print(f'  [{symbol}] Yahoo Finance HTTP {r.status_code} (ticker={ys})')
        r.raise_for_status()
        news = r.json().get('news', [])
        posts = []
        for n in news:
            title = (n.get('title') or '').strip()
            if title:
                posts.append({
                    'description': title,
                    'like_count':  5,
                    'reply_count': 1,
                })
        print(f'  [{symbol}] Yahoo Finance 获取 {len(posts)} 条新闻')
        return posts
    except Exception as e:
        print(f'  [{symbol}] Yahoo Finance 失败: {e}')
        return []

# ── 顶层帖子获取（降级链） ───────────────────────────────────────

def fetch_stock_posts(symbol):
    """雪球 timeline → Yahoo Finance 新闻（两级降级）。"""
    # 1. Xueqiu（需要 XQ_TOKEN；GitHub Actions IP 通常被 Bot 检测）
    posts = _xueqiu_posts(symbol, pages=3)
    if posts:
        print(f'  [{symbol}] 雪球获取成功 {len(posts)} 条')
        return posts

    # 2. Yahoo Finance 新闻（全球可达，GPT 可分析英文标题输出中文观点）
    print(f'  [{symbol}] 雪球无数据，切换 Yahoo Finance…')
    posts = _yahoo_news_posts(symbol)
    if posts:
        return posts

    print(f'  [{symbol}] 所有数据源均失败，返回空列表')
    return []

# ── 情感分析（关键词） ─────────────────────────────────────────

def keyword_analyze(posts):
    scored = []
    for p in posts:
        raw  = p.get('description') or p.get('text') or p.get('title') or ''
        txt  = clean_html(raw)
        disp = txt[:60]
        eng  = (p.get('like_count') or 0)*3 + (p.get('reply_count') or 0)*2
        scored.append({'disp': disp, 'score': score_sentiment(txt), 'eng': eng})

    pos = [x['disp'] for x in sorted(
               [x for x in scored if x['score']>0], key=lambda x:-x['eng'])[:3] if x['disp']]
    neg = [x['disp'] for x in sorted(
               [x for x in scored if x['score']<0], key=lambda x:-x['eng'])[:3] if x['disp']]
    if not pos and scored:
        pos = [x['disp'] for x in sorted(scored, key=lambda x:-x['eng'])[:2] if x['disp']]
    return pos, neg, len(posts)

# ── 情感分析（GitHub Models / gpt-4o-mini） ───────────────────

def ai_analyze(name, symbol, posts):
    if not GITHUB_TOKEN:
        return keyword_analyze(posts)
    texts = [clean_html(p.get('description') or p.get('text') or '')[:120]
             for p in posts[:40]]
    texts = [t for t in texts if t]
    if not texts:
        return keyword_analyze(posts)

    sample = '\n'.join(f'{i+1}. {t}' for i,t in enumerate(texts[:30]))
    prompt = (f'以下是关于{name}（{symbol}）的最新市场新闻与讨论标题'
              f'（共{len(texts)}条，可能含英文）：\n\n'
              f'{sample}\n\n'
              f'请仔细阅读并分析这些标题的市场含义，然后提取：\n'
              f'1. 最具代表性的3条正面/看多观点（用中文简洁概括，每条不超过40字）\n'
              f'2. 最具代表性的3条负面/看空观点（用中文简洁概括，每条不超过40字）\n\n'
              f'要求：\n'
              f'- 英文标题请翻译理解后再归纳，不要直接照搬英文\n'
              f'- 观点要反映新闻的实质内容，而不仅仅是标题描述\n'
              f'- 如不足3条可以少于3条，完全没有则返回空列表\n\n'
              f'仅返回JSON，格式：{{"pos":["..."],"neg":["..."]}}')
    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={'Authorization':f'Bearer {GITHUB_TOKEN}','Content-Type':'application/json'},
            json={'model':'gpt-4o-mini','messages':[{'role':'user','content':prompt}],
                  'max_tokens':500,'temperature':0.3},
            timeout=30)
        r.raise_for_status()
        raw = r.json()['choices'][0]['message']['content'].strip()
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            j = json.loads(m.group())
            pos = [x for x in j.get('pos',[]) if x and x!='...'][:3]
            neg = [x for x in j.get('neg',[]) if x and x!='...'][:3]
            return pos, neg, len(posts)
    except Exception as e:
        print(f'  [AI] GitHub Models 失败: {e}，回退关键词')
    return keyword_analyze(posts)

# ── 读取组合 ───────────────────────────────────────────────────

def load_portfolio():
    for path in [os.path.join(os.getcwd(),'portfolio.json'),
                 os.path.normpath(os.path.join(
                     os.path.dirname(os.path.abspath(__file__)),'..','..','portfolio.json'))]:
        if os.path.exists(path):
            print(f'  [组合] 读取 {path}')
            with open(path,'r',encoding='utf-8') as f:
                return json.load(f)
    print('  [组合] portfolio.json 未找到')
    return None

def get_top5(portfolio):
    stocks = [sk for sec in portfolio.get('sectors',[])
              for sk in sec.get('stocks',[]) if (sk.get('w') or 0)>0]
    return sorted(stocks, key=lambda x:-(x.get('w') or 0))[:5]

# ── 主程序 ─────────────────────────────────────────────────────

def main():
    os.makedirs('data', exist_ok=True)
    ts = now_ts()
    print(f'\n=== 数据刷新  {ts} ===\n')

    xq_session()  # 预热一次

    # 1. 热股榜
    print('\n📊 获取雪球热股榜…')
    hot = fetch_hot_stocks()
    with open('data/xq_hot.json','w',encoding='utf-8') as f:
        json.dump({'ts':ts,'list':hot}, f, ensure_ascii=False, indent=2)
    print(f'   ✅ {len(hot)} 只 → data/xq_hot.json')

    # 2. 权重股舆情（Yahoo Finance 新闻 → GPT 归纳中文观点）
    print('\n🔍 获取 Top5 权重股舆情…')
    portfolio = load_portfolio()
    if not portfolio:
        with open('data/xq_sentiment.json','w',encoding='utf-8') as f:
            json.dump({'ts':ts,'stocks':[]}, f, ensure_ascii=False)
        return

    top5 = get_top5(portfolio)
    if not top5:
        print('   ⚠️  portfolio 中无权重股')
        with open('data/xq_sentiment.json','w',encoding='utf-8') as f:
            json.dump({'ts':ts,'stocks':[]}, f, ensure_ascii=False)
        return

    use_ai = bool(GITHUB_TOKEN)
    print(f'   分析方式: {"GitHub Models / gpt-4o-mini" if use_ai else "关键词匹配"}')

    results = []
    for sk in top5:
        sym  = xq_symbol(sk)
        name = sk.get('name', sym)
        w    = sk.get('w', 0)
        print(f'\n   [{sym}] {name} ({w}%) …')
        posts = fetch_stock_posts(sym)
        print(f'   [{sym}] 共 {len(posts)} 条')
        pos, neg, total = ai_analyze(name, sym, posts) if use_ai else keyword_analyze(posts)
        print(f'   [{sym}] 🟢 {len(pos)}  🔴 {len(neg)}')
        results.append({'code':sym,'name':name,'w':w,'pos':pos,'neg':neg,'total':total})
        time.sleep(0.8)

    with open('data/xq_sentiment.json','w',encoding='utf-8') as f:
        json.dump({'ts':ts,'stocks':results}, f, ensure_ascii=False, indent=2)
    print(f'\n✅ 完成 → data/xq_sentiment.json  ({len(results)} 只  {ts})\n')

if __name__ == '__main__':
    main()
