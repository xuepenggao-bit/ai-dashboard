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

# 行业中文→英文关键词（用于 Yahoo Finance 行业维度搜索）
INDUSTRY_EN = {
    '光模块': 'optical transceiver 800G',
    'PCB':   'PCB AI server circuit board',
    '存储':   'memory chip HBM NAND DRAM',
    '发电':   'oilfield equipment gas turbine',
    '电源':   'power electronics supply AI server',
    '液冷':   'liquid cooling data center',
    'AI应用': 'AI application software',
    '电动车': 'electric vehicle EV',
    '锂电':   'lithium battery',
    '储能':   'energy storage',
    '生物药': 'biopharmaceuticals oncology',
}

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

def _xueqiu_posts(symbol, pages=2):
    """雪球个股讨论搜索接口 symbol/search/status.json（先 GET 首页取 cookie，
    本地/常规 IP 可用；配 XQ_TOKEN 登录态可提升数据中心 IP 成功率）。"""
    posts = []
    sess = xq_session()
    for page in range(1, pages + 1):
        url = ('https://xueqiu.com/query/v1/symbol/search/status.json'
               f'?count=20&comment=0&symbol={symbol}&hl=0&source=all'
               f'&sort=time&page={page}&type=11&_={int(time.time()*1000)}')
        try:
            r = sess.get(url, timeout=15, headers={'Referer': f'https://xueqiu.com/S/{symbol}'})
            print(f'  [{symbol}] XQ status 第{page}页 HTTP {r.status_code}')
            if r.status_code in (400, 401, 403):
                break
            r.raise_for_status()
            if _is_html(r):
                print(f'  [{symbol}] XQ 返回 HTML（Bot 检测），停止')
                break
            lst = r.json().get('list', [])
            posts.extend(lst)
            if len(lst) < 15:
                break
        except Exception as e:
            print(f'  [{symbol}] XQ 第{page}页异常: {e}')
            break
        if page < pages:
            time.sleep(0.6)
    return posts

def _hk_to_ashare(name):
    """港股名称 → 同名 A 股 symbol（雪球 suggest 接口）。
    很多港股有同名 A 股且讨论更活跃，故用 A 股代抓。无同名 A 股返回 None。"""
    if not name:
        return None
    try:
        sess = xq_session()
        url = 'https://xueqiu.com/query/v1/suggest_stock.json?q=' + requests.utils.quote(name)
        r = sess.get(url, timeout=10, headers={'Referer': 'https://xueqiu.com/'})
        if r.status_code != 200 or _is_html(r):
            return None
        data = r.json().get('data', [])
        # 优先精确同名的 A 股（SH/SZ）
        for it in data:
            code = it.get('code', '')
            if code[:2] in ('SH', 'SZ') and it.get('query', '') == name:
                return code
        # 放宽：第一个 A 股匹配
        for it in data:
            code = it.get('code', '')
            if code[:2] in ('SH', 'SZ'):
                return code
    except Exception as e:
        print(f'  [{name}] 港股→A股映射失败: {e}')
    return None

# ── 情感来源 2：Yahoo Finance 新闻（全球可达，无需认证） ─────────

def _yahoo_news_posts(symbol, name='', industry=''):
    """
    Yahoo Finance 新闻搜索（query2.finance.yahoo.com）。
    查询顺序：①股票代码  ②行业英文关键词（不用中文名，中文会返回 400）。
    合并去重，最多 50 条，交由 AI 归纳当前观点。
    """
    import urllib.parse
    ys   = _yahoo_symbol(symbol)
    # 行业英文关键词（跳过中文名，中文查询 Yahoo Finance 返回 400）
    ind_en = INDUSTRY_EN.get(industry, '') if industry else ''
    queries = [ys] + ([ind_en] if ind_en else [])

    hdrs = {
        'User-Agent': UA_BROWSER,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    seen, posts = set(), []

    for q in queries:
        url = (f'https://query2.finance.yahoo.com/v1/finance/search'
               f'?q={urllib.parse.quote(q)}&newsCount=30&quotesCount=0&enableFuzzyQuery=false')
        try:
            r = requests.get(url, headers=hdrs, timeout=15)
            print(f'  [{symbol}] Yahoo q={q!r} HTTP {r.status_code}')
            if r.status_code != 200:
                continue
            for n in r.json().get('news', []):
                title = (n.get('title') or '').strip()
                if title and title not in seen:
                    seen.add(title)
                    posts.append({'description': title, 'like_count': 5, 'reply_count': 1})
        except Exception as e:
            print(f'  [{symbol}] Yahoo q={q!r} 失败: {e}')
        if len(posts) >= 50:
            break
        time.sleep(0.3)

    print(f'  [{symbol}] Yahoo Finance 合计 {len(posts)} 条（去重后）')
    return posts

# ── 顶层帖子获取（降级链） ───────────────────────────────────────

def _cn_announcements(symbol):
    """
    获取中文公告标题作为情感信号（两个接口依次尝试）：
    ① 东方财富 np-anotice-stock（SECID 格式：0.300394 / 1.603986）
    ② 巨潮资讯 CNINFO（stock 仅用纯数字代码，column=szse/sse）
    HK 股跳过（A 股公告 API 不覆盖港股）。
    """
    if symbol.startswith('HK'):
        return []   # HK 股无 A 股公告数据库覆盖

    code = _em_code(symbol)   # 纯数字，如 '300394'
    is_sh = symbol.startswith('SH')
    secid = f'{"1" if is_sh else "0"}.{code}'   # EastMoney SECID 格式

    # ── ① 东方财富（SECID 格式） ─────────────────────────────────
    hdrs_em = {
        'User-Agent': UA_BROWSER,
        'Referer': 'https://data.eastmoney.com/',
        'Accept': 'application/json',
    }
    url_em = (f'https://np-anotice-stock.eastmoney.com/api/security/ann'
              f'?sr=-1&page=1&num=20&type=A&fs={secid}')
    try:
        r = requests.get(url_em, headers=hdrs_em, timeout=15)
        print(f'  [{symbol}] EM公告 HTTP {r.status_code} (fs={secid})')
        if r.status_code == 200:
            items = r.json().get('data', {}).get('list', []) or []
            posts = [{'description': (it.get('title') or '').strip(),
                      'like_count': 3, 'reply_count': 1}
                     for it in items if it.get('title')]
            if posts:
                print(f'  [{symbol}] EM公告 获取 {len(posts)} 条')
                return posts
    except Exception as e:
        print(f'  [{symbol}] EM公告 失败: {e}')

    # ── ② 巨潮资讯 CNINFO（stock 只传数字代码）────────────────────
    column = 'sse' if is_sh else 'szse'
    url_cn = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
    data_cn = {
        'stock':    code,          # 只传数字：'300394'（不带市场前缀）
        'category': '',            # 空=全部类型
        'pageNum':  1,
        'pageSize': 20,
        'column':   column,        # 'sse' 上海 / 'szse' 深圳
        'tabName':  'fulltext',
    }
    hdrs_cn = {
        'User-Agent': UA_BROWSER,
        'Referer':    'http://www.cninfo.com.cn/',
        'Accept':     'application/json, text/javascript, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    try:
        r = requests.post(url_cn, data=data_cn, headers=hdrs_cn, timeout=15)
        print(f'  [{symbol}] CNINFO HTTP {r.status_code}')
        if r.status_code == 200:
            announcements = r.json().get('announcements') or []
            posts = [{'description': (a.get('announcementTitle') or '').strip(),
                      'like_count': 3, 'reply_count': 1}
                     for a in announcements if a.get('announcementTitle')]
            if posts:
                print(f'  [{symbol}] CNINFO 获取 {len(posts)} 条')
                return posts
            else:
                print(f'  [{symbol}] CNINFO 返回空列表')
    except Exception as e:
        print(f'  [{symbol}] CNINFO 失败: {e}')

    return []


def _ddg_cn_news(name, industry='', n=10):
    """DuckDuckGo 中文搜索个股最新新闻/讨论（A股舆情主力，GitHub Actions 可用，
    替代对A股几乎无料的 Yahoo 英文）。返回 [{description, text}]。"""
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        print('  [DDG] duckduckgo_search 未安装'); return []
    posts = []
    q = f'{name} 股票 最新 业绩 公告 机构 评论 {industry}'.strip()
    try:
        with DDGS() as ddgs:
            for r in ddgs.text(q, region='cn-zh', max_results=n):
                title = (r.get('title') or '').strip()
                body  = (r.get('body')  or '').strip()
                if title:
                    posts.append({'description': (title + '。' + body)[:300], 'text': title})
        print(f'  [{name}] DDG中文新闻 {len(posts)} 条')
    except Exception as e:
        print(f'  [{name}] DDG搜索失败: {e}')
    return posts

def _em_news(name, n=10):
    """东方财富个股新闻搜索（中文，个股直接相关，含最新动态/研报/资讯）。
    GitHub Actions 可达性优于 DDG/雪球，为 A股舆情主力源。返回 [{description, text}]。"""
    if not name:
        return []
    param = json.dumps({
        'keyword': name,
        'type': ['cmsArticleWebOld'],
        'param': {'cmsArticleWebOld': {'searchScope': 'default', 'sort': 'time',
                                       'pageIndex': 1, 'pageSize': n, 'preTag': '', 'postTag': ''}}
    }, ensure_ascii=False)
    url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + requests.utils.quote(param)
    try:
        r = requests.get(url, timeout=15, headers={
            'User-Agent': UA_BROWSER, 'Referer': 'https://so.eastmoney.com/'})
        m = re.search(r'cb\((.*)\)', r.text, re.DOTALL)
        if not m:
            print(f'  [{name}] 东财新闻：无JSONP'); return []
        arts = (json.loads(m.group(1)).get('result') or {}).get('cmsArticleWebOld') or []
        posts = []
        for a in arts:
            title   = re.sub(r'<[^>]+>', '', a.get('title', '') or '').strip()
            content = re.sub(r'<[^>]+>', '', a.get('content', '') or '').strip()
            if title:
                posts.append({'description': (title + '。' + content)[:300], 'text': title})
        print(f'  [{name}] 东财新闻 {len(posts)} 条')
        return posts
    except Exception as e:
        print(f'  [{name}] 东财新闻失败: {e}')
        return []

def fetch_stock_posts(symbol, name='', industry=''):
    """雪球讨论 → 东财个股新闻 → DDG中文新闻 → 公告 → Yahoo（五级降级）。
    港股用同名 A 股抓数据；雪球在数据中心IP被反爬时，东财新闻为A股舆情主力。"""
    # 港股 → 同名 A 股 symbol
    xq_sym = symbol
    if symbol.startswith('HK') and name:
        a = _hk_to_ashare(name)
        if a:
            print(f'  [{symbol}] 港股→同名A股 {a} 抓数据')
            xq_sym = a

    # 1. 雪球个股讨论（本地/常规IP可用；GitHub Actions 数据中心IP常被Bot检测拦截）
    posts = _xueqiu_posts(xq_sym, pages=2)
    if posts:
        print(f'  [{symbol}] 雪球获取成功 {len(posts)} 条（symbol={xq_sym}）')
        return posts

    # 2. 东方财富个股新闻（中文，个股相关，Actions 主力源）
    print(f'  [{symbol}] 雪球无数据，切换东财个股新闻…')
    posts = _em_news(name)
    if posts:
        return posts

    # 3. DuckDuckGo 中文新闻（兜底；Actions 数据中心IP 可能被限）
    print(f'  [{symbol}] 东财新闻无数据，切换 DDG…')
    posts = _ddg_cn_news(name, industry)
    if posts:
        return posts

    # 4. 公告（东方财富/巨潮）
    print(f'  [{symbol}] DDG无数据，切换公告接口…')
    posts = _cn_announcements(symbol)
    if posts:
        return posts

    # 5. Yahoo Finance（A股几乎无料，最后兜底）
    print(f'  [{symbol}] 公告失败，切换 Yahoo Finance…')
    posts = _yahoo_news_posts(symbol, name=name, industry=industry)
    if posts:
        return posts

    print(f'  [{symbol}] 所有数据源均失败，返回空列表')
    return []

# ── 观点归纳（关键词降级方案） ───────────────────────────────────

def keyword_analyze(posts):
    """AI 不可用时的关键词降级，直接拼接最相关的若干条标题作为概况。"""
    scored = []
    for p in posts:
        raw  = p.get('description') or p.get('text') or p.get('title') or ''
        txt  = clean_html(raw)
        if not txt:
            continue
        eng  = (p.get('like_count') or 0)*3 + (p.get('reply_count') or 0)*2
        scored.append({'txt': txt[:80], 'score': score_sentiment(txt), 'eng': eng})

    if not scored:
        return '', len(posts)

    # 取得分最高的 5 条拼成概况
    top = sorted(scored, key=lambda x: -x['eng'])[:5]
    summary = '；'.join(x['txt'] for x in top if x['txt'])
    return summary, len(posts)

# ── 观点归纳（GitHub Models / gpt-4o-mini） ──────────────────────

def ai_analyze(name, symbol, posts, industry=''):
    """
    用 GPT-4o-mini 对最新 50 条讨论/新闻归纳当前市场观点。
    返回 (summary:str, total:int)，summary 为 2-4 句中文概况（最多150字）。
    """
    if not GITHUB_TOKEN:
        return keyword_analyze(posts)

    texts = [clean_html(p.get('description') or p.get('text') or '')[:150]
             for p in posts[:50]]
    texts = [t for t in texts if t]
    if not texts:
        return keyword_analyze(posts)

    ind_en  = INDUSTRY_EN.get(industry, '') if industry else ''
    ind_ctx = f'，行业：{industry}（{ind_en}）' if industry else ''
    sample  = '\n'.join(f'{i+1}. {t}' for i, t in enumerate(texts[:50]))

    prompt = (
        f'以下是与 {name}（{symbol}{ind_ctx}）相关的最新讨论/新闻标题或公告摘要'
        f'（共 {len(texts)} 条，含中文公告和/或英文新闻）：\n\n'
        f'{sample}\n\n'
        f'请根据上述内容，用 2-4 句中文归纳当前市场对该股的主流观点和关注焦点。要求：\n'
        f'① 直接提及 {name} 或 {symbol} 的内容优先归纳\n'
        f'② 涉及"{industry}"行业趋势且明确影响该股的，可纳入（注明"行业"）\n'
        f'③ 中文公告（回购/增减持/业绩预告等）据实解读含义\n'
        f'④ 与该股及行业均无关联的通用新闻忽略不计\n'
        f'⑤ 如确实无相关内容，返回空字符串\n'
        f'语言风格：客观简洁，不加主观判断，不超过 150 字。\n\n'
        f'输出（仅返回 JSON，不要任何解释）：\n'
        f'{{"summary":"2-4句中文概况"}}'
    )
    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={'Authorization': f'Bearer {GITHUB_TOKEN}', 'Content-Type': 'application/json'},
            json={'model': 'gpt-4o-mini',
                  'messages': [{'role': 'user', 'content': prompt}],
                  'max_tokens': 400, 'temperature': 0.3},
            timeout=30)
        r.raise_for_status()
        raw = r.json()['choices'][0]['message']['content'].strip()
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            j = json.loads(m.group())
            summary = (j.get('summary') or '').strip()
            return summary, len(posts)
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

def get_top_weights(portfolio, n=8):
    stocks = [sk for sec in portfolio.get('sectors',[])
              for sk in sec.get('stocks',[]) if (sk.get('w') or 0)>0]
    return sorted(stocks, key=lambda x:-(x.get('w') or 0))[:n]

# ── 投资者关系活动记录表（东财公告） ──────────────────────────────

def _em_suggest_code(name):
    """股票名 → A股代码（东财 suggest）；用于港股映射到同名A股。"""
    if not name:
        return ''
    try:
        url = ('https://searchapi.eastmoney.com/api/suggest/get?input=' + requests.utils.quote(name)
               + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8')
        r = requests.get(url, timeout=10, headers={'User-Agent': UA_BROWSER, 'Referer': 'https://www.eastmoney.com/'})
        txt = r.text
        m = re.search(r'\((\{.*\})\)\s*;?\s*$', txt, re.DOTALL)   # 剥可能的 JSONP
        data = json.loads(m.group(1) if m else txt)
        arr = (data.get('QuotationCodeTable') or {}).get('Data') or []
        for x in arr:
            if x.get('Classify') == 'AStock':
                return x.get('Code', '')
    except Exception as e:
        print(f'  [suggest] {name}: {e}')
    return ''

def _em_ir_record(code):
    """个股最近一次「投资者关系活动记录表」（标题+日期+全文）。无则 None。"""
    if not code:
        return None
    try:
        url = (f'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=30'
               f'&page_index=1&ann_type=A&client_source=web&stock_list={code}&f_node=0&s_node=0')
        r = requests.get(url, timeout=15, headers={'User-Agent': UA_BROWSER, 'Referer': 'https://data.eastmoney.com/'})
        lst = (r.json().get('data') or {}).get('list') or []
    except Exception as e:
        print(f'  [IR] {code} 公告列表失败: {e}')
        return None
    ir = next((a for a in lst if '投资者关系活动记录' in (a.get('title') or '')), None)
    if not ir:
        return None
    art   = ir.get('art_code', '')
    title = ir.get('title', '')
    date  = (ir.get('notice_date') or '')[:10]
    content = ''
    try:
        url2 = f'https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code={art}&client_source=web&page_index=1'
        r2 = requests.get(url2, timeout=15, headers={'User-Agent': UA_BROWSER, 'Referer': 'https://data.eastmoney.com/'})
        content = ((r2.json().get('data') or {}).get('notice_content') or '').strip()
    except Exception as e:
        print(f'  [IR] {art} 全文失败: {e}')
    return {'art_code': art, 'title': title, 'date': date, 'fulltext': content}

def _ir_summarize(name, fulltext):
    """GPT-4o-mini 摘要投资者关系活动记录表核心内容。"""
    if not GITHUB_TOKEN or not fulltext:
        return ''
    prompt = (f'以下是{name}最近一次投资者关系活动记录表全文：\n\n{fulltext[:3500]}\n\n'
              '请用3-5句中文摘要本次调研核心：机构关注的问题，以及公司就经营/业务/产能/'
              '订单/技术/展望等给出的关键回应与数据。客观简洁，不超过180字，只返回摘要文本。')
    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={'Authorization': f'Bearer {GITHUB_TOKEN}', 'Content-Type': 'application/json'},
            json={'model': 'gpt-4o-mini', 'messages': [{'role': 'user', 'content': prompt}],
                  'max_tokens': 400, 'temperature': 0.3}, timeout=40)
        r.raise_for_status()
        return r.json()['choices'][0]['message']['content'].strip()
    except Exception as e:
        print(f'  [IR] {name} 摘要失败: {e}')
        return ''

# ── 主程序 ─────────────────────────────────────────────────────

def fetch_macro_profit():
    """工业企业营业利润累计同比(东财) + 计算机通信电子营业利润累计同比(国家统计局)。"""
    UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    out = {'industrial': [], 'electronic': []}
    # ① 东财：规模以上工业企业营业利润累计同比
    try:
        u = ('https://datacenter-web.eastmoney.com/api/data/v1/get?source=WEB&client=WEB'
             '&pageSize=30&sortColumns=REPORT_DATE&sortTypes=-1'
             '&reportName=RPT_ECONOMY_PROFITGROW&columns=REPORT_DATE,ACCUMULATE_GROW,YEAR_RATIO,VALUE')
        r = requests.get(u, headers={'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/'}, timeout=15)
        j = r.json()
        rows = (j.get('result') or {}).get('data') or []
        print(f'[macro] 东财工业利润 success={j.get("success")} count={len(rows)}')
        for d in reversed(rows):
            v = d.get('ACCUMULATE_GROW')
            if v is None or v == '':
                v = d.get('YEAR_RATIO')
            out['industrial'].append({'date': str(d.get('REPORT_DATE', ''))[:7], 'val': v})
    except Exception as e:
        print(f'[macro] 东财工业利润 FAIL: {e}')
    # ② 国家统计局：计算机/通信/电子设备制造业(C39) 营业利润累计增速(A0E0G)
    try:
        s = requests.Session()
        s.headers.update({'User-Agent': UA,
                          'Referer': 'https://data.stats.gov.cn/easyquery.htm?cn=A01',
                          'Accept': 'application/json, text/javascript, */*'})
        s.get('https://data.stats.gov.cn/easyquery.htm?cn=A01', timeout=15)  # 取 cookie
        nbs = ('https://data.stats.gov.cn/easyquery.htm?m=QueryData&dbcode=hgyd&rowcode=zb&colcode=sj'
               '&wds=[{"wdcode":"hy","valuecode":"C39"}]'
               '&dfwds=[{"wdcode":"zb","valuecode":"A0E0G"}]&k1=' + str(int(time.time() * 1000)))
        r = s.get(nbs, timeout=15)
        print(f'[macro] 统计局电子利润 HTTP {r.status_code}')
        j = r.json()
        nodes = (j.get('returndata') or {}).get('datanodes') or []
        print(f'[macro] 统计局 datanodes={len(nodes)}')
        for n in nodes:
            sd = (n.get('data') or {}).get('strdata', '')
            if not sd:
                continue
            sj = next((w['valuecode'] for w in n.get('wds', []) if w.get('wdcode') == 'sj'), '')
            m = re.match(r'(\d{4})(\d{2})', sj)
            lbl = f'{m.group(1)}-{m.group(2)}' if m else sj
            try:
                out['electronic'].append({'date': lbl, 'val': float(sd)})
            except ValueError:
                pass
        out['electronic'].sort(key=lambda x: x['date'])
        if out['electronic']:
            print(f'[macro] 统计局电子利润最新: {out["electronic"][-1]}')
    except Exception as e:
        print(f'[macro] 统计局电子利润 FAIL: {e}')
    return out


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

    # 1.5 宏观利润（工业 + 计算机通信电子）— 验证 Actions 服务器端能否抓到国家统计局
    print('\n📈 获取宏观营业利润累计同比…')
    mp = fetch_macro_profit()
    with open('data/macro_profit.json','w',encoding='utf-8') as f:
        json.dump({'ts':ts, **mp}, f, ensure_ascii=False, indent=2)
    print(f"   工业{len(mp['industrial'])}期 / 电子{len(mp['electronic'])}期 → data/macro_profit.json")

    # 2. 权重股投资者关系活动记录表（最近一次 → 全文 → GPT摘要）
    #    热股榜每 15 分钟刷新；公告/记录表一天难得更新一次，故每天只抓一次：
    #    若已有 ir_records.json 且其日期为今天，则跳过（手动触发可设 FORCE_IR=1 强制刷新）。
    today    = ts[:10]
    force_ir = (os.environ.get('FORCE_IR', '').strip() in ('1', 'true', 'yes')
                or os.environ.get('GITHUB_EVENT_NAME', '') == 'workflow_dispatch')
    skip_ir  = False
    if not force_ir and os.path.exists('data/ir_records.json'):
        try:
            with open('data/ir_records.json', encoding='utf-8') as f:
                _old = json.load(f)
            if _old.get('ts', '')[:10] == today and _old.get('records'):
                skip_ir = True
                print(f'\n📋 权重股公告今日已抓取（{_old.get("ts")}），本次跳过，仅刷新热股榜')
        except Exception:
            pass
    if skip_ir:
        return

    print('\n📋 获取 Top8 权重股投资者关系活动记录表…')
    portfolio = load_portfolio()
    ir_results = []
    if portfolio:
        for sk in get_top_weights(portfolio, 8):
            sym  = xq_symbol(sk)
            name = sk.get('name', sym)
            w    = sk.get('w', 0)
            # A股直接用代码；港股映射到同名A股代码
            if sk.get('mkt') == 'HK':
                acode = _em_suggest_code(name) or str(sk.get('code', ''))
            else:
                acode = str(sk.get('code', ''))
            print(f'\n   [{sym}] {name} ({w}%)  A股code={acode} …')
            rec = _em_ir_record(acode)
            if rec and rec.get('fulltext'):
                summ = _ir_summarize(name, rec['fulltext'])
                print(f'   [{sym}] {rec["date"]} {rec["title"][:28]} | 全文{len(rec["fulltext"])}字 摘要{len(summ)}字')
                ir_results.append({'code': sym, 'name': name, 'w': w, 'a_code': acode,
                                   'date': rec['date'], 'title': rec['title'], 'art_code': rec['art_code'],
                                   'summary': summ, 'fulltext': rec['fulltext']})
            else:
                print(f'   [{sym}] 无投资者关系活动记录表')
                ir_results.append({'code': sym, 'name': name, 'w': w, 'a_code': acode,
                                   'date': '', 'title': '', 'art_code': '',
                                   'summary': '暂无投资者关系活动记录', 'fulltext': ''})
            time.sleep(0.6)

    with open('data/ir_records.json', 'w', encoding='utf-8') as f:
        json.dump({'ts': ts, 'records': ir_results}, f, ensure_ascii=False, indent=2)
    print(f'\n✅ 完成 → data/ir_records.json  ({len(ir_results)} 只  {ts})\n')

if __name__ == '__main__':
    main()
