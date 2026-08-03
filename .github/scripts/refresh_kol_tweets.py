#!/usr/bin/env python3
"""
Refresh X KOL (Key Opinion Leader) summaries.

Data source:
  Bing News RSS — searches each KOL's name + handle for recent articles/quotes.
  No API key or X login required; works from any IP.

Pipeline:
  1. Load accounts from data/twitter_following.json
  2. For each category, search Bing News for top accounts in that category
  3. Collect news snippets mentioning each person
  4. Per category: build a deterministic Chinese digest from themes and entities
  5. Write data/twitter_kol_summary.json

The summariser intentionally has no external AI dependency. GitHub Models was
retired on 2026-07-30; a local fallback guarantees that non-empty news batches
cannot silently produce empty summaries again.
"""
import os, json, re, datetime, time, urllib.parse, requests, html
import xml.etree.ElementTree as ET
from collections import Counter
from email.utils import parsedate_to_datetime

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT    = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
      'AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0.0.0 Safari/537.36')

# ── meta-category mapping (same as before) ─────────────────────────
META_CATS = [
    {
        'name': 'AI技术研究',
        'color': '#7c3aed',
        'topics': ['AI行业/学术','AI行业/Claude Code','AI行业/HuggingFace',
                   'AI行业/DeepMind','AI行业/谷歌','AI行业/Anthropic',
                   'AI行业/SSI','AI行业/安全','AI行业/伦理','AI行业',
                   'AI行业/半导体','AI行业/投资'],
    },
    {
        'name': 'AI应用与科技',
        'color': '#0369a1',
        'topics': ['AI工具','AI/提示工程','AI行业分析','AI干货/投资',
                   'AI芯片/资本市场','AI/投资工具','AI/投资','前沿科技/资本',
                   '科技','科技行业研究','科技产业/苹果'],
    },
    {
        'name': '投资策略',
        'color': '#059669',
        'topics': ['投资理念','投资理念/量化','投资理念/宏观','投资理念/交易',
                   '投资理念/教育','投资','价值投资','小盘股投资',
                   '投资/科技股','投资管理','投资/加密/宏观',
                   '加密货币/AI','加密货币/金融'],
    },
    {
        'name': '宏观与市场',
        'color': '#dc2626',
        'topics': ['宏观经济','市场策略','估值/金融','资产管理'],
    },
]

HANDLE_OVERRIDE = {
    'trendforce':   '科技行业',
    '168X_Fortune': 'AI应用与动态',
}

def get_meta_cat(handle, topic):
    if handle in HANDLE_OVERRIDE:
        return HANDLE_OVERRIDE[handle]
    for mc in META_CATS:
        if topic in mc['topics']:
            return mc['name']
    t = topic.lower()
    if 'ai' in t and '投资' not in t: return 'AI技术研究'
    if '投资' in t or '价值' in t or '交易' in t: return '投资策略'
    if '宏观' in t or '市场' in t or '估值' in t: return '宏观与市场'
    if '加密' in t: return '投资策略'
    if '科技' in t: return '科技行业'
    return 'AI应用与动态'

def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')

def load_following():
    path = os.path.join(REPO_ROOT, 'data', 'twitter_following.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def build_cat_map(following):
    cats = {mc['name']: [] for mc in META_CATS}
    for acc in following.get('accounts', []):
        if not acc.get('enabled', True):
            continue
        # 优先用清单里已分好的 cat 字段；缺失或非法则回退按 topic 模糊归类
        meta = acc.get('cat')
        if meta not in cats:
            meta = get_meta_cat(acc['handle'], acc.get('topic', ''))
        if meta in cats:
            cats[meta].append(acc)
    return cats

# ── News RSS fetch ───────────────────────────────────────────────────

MAX_AGE_H = 24   # 只保留过去 24 小时内发布的条目

def _parse_rss_items(xml_text, count):
    """解析 RSS，返回 [{title,desc,link,source,pubDate,pub_iso}]，并过滤为过去 24 小时内。"""
    posts = []
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        root = ET.fromstring(xml_text)
        for item in root.findall('.//item'):
            title = (item.findtext('title') or '').strip()
            if not title:
                continue
            link = (item.findtext('link') or '').strip()
            desc = (item.findtext('description') or '').strip()
            desc = re.sub(r'<[^>]+>', ' ', desc)
            desc = re.sub(r'\s+', ' ', desc).strip()[:300]
            pub  = (item.findtext('pubDate') or '').strip()
            # source 子标签（Google News 提供媒体来源）
            source = ''
            for se in item.iter():
                if se.tag.endswith('source') and (se.text or '').strip():
                    source = se.text.strip(); break
            # 解析时间并做 24 小时过滤
            pub_dt = None
            if pub:
                try:
                    pub_dt = parsedate_to_datetime(pub)
                    if pub_dt.tzinfo is None:
                        pub_dt = pub_dt.replace(tzinfo=datetime.timezone.utc)
                except Exception:
                    pub_dt = None
            if pub_dt is not None and (now - pub_dt).total_seconds() > MAX_AGE_H * 3600:
                continue
            posts.append({
                'title': title, 'desc': desc, 'link': link, 'source': source,
                'pubDate': pub,
                'pub_iso': pub_dt.astimezone(datetime.timezone.utc).isoformat() if pub_dt else '',
            })
            if len(posts) >= count:
                break
    except Exception:
        pass
    return posts

def _fetch_google_news(display_name, handle, count=6):
    """Google News RSS（when:1d 限定过去 24 小时）。"""
    q   = urllib.parse.quote(f'"{display_name}" when:1d')
    url = f'https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en'
    try:
        r = requests.get(url, headers={'User-Agent': UA,
                                       'Accept': 'application/rss+xml, text/xml, */*'},
                         timeout=15)
        print(f'    [GNews] HTTP {r.status_code}')
        if r.status_code == 200:
            return _parse_rss_items(r.text, count)
    except Exception as e:
        print(f'    [GNews] {display_name}: {e}')
    return []

def _fetch_bing_news(display_name, handle, count=6):
    """Bing News RSS — 备用（_parse_rss_items 内已按 pubDate 做 24h 过滤）。"""
    q   = urllib.parse.quote(f'"{display_name}"')
    url = f'https://www.bing.com/news/search?q={q}&format=rss&count={count*3}'
    try:
        r = requests.get(url, headers={'User-Agent': UA}, timeout=12)
        print(f'    [Bing]  HTTP {r.status_code}')
        if r.status_code == 200:
            return _parse_rss_items(r.text, count)
    except Exception as e:
        print(f'    [Bing]  {display_name}: {e}')
    return []

def _news_posts(display_name, handle, count=6):
    """Google News 优先，空则 Bing。返回 post dict 列表（过去 24h）。"""
    items = _fetch_google_news(display_name, handle, count)
    if not items:
        items = _fetch_bing_news(display_name, handle, count)
    return items

def fetch_news_for_category(cat_name, accounts):
    """抓取该分类下所有账号过去 24h 的新闻，汇总为按时间倒序的流水列表。"""
    posts = []
    for acc in accounts:
        handle       = acc['handle']
        display_name = acc.get('display_name', handle)
        items        = _news_posts(display_name, handle, count=6)
        for it in items:
            it['handle']       = handle
            it['display_name'] = display_name
        posts.extend(items)
        print(f'  {"✓" if items else "·"} @{handle}: {len(items)} 条（24h）')
        time.sleep(0.4)
    posts.sort(key=lambda p: p.get('pub_iso', ''), reverse=True)   # 新→旧
    return posts

# ── Local summarisation (no model/API dependency) ───────────────────

THEME_RULES = [
    ('大模型与智能体', r'\b(openai|anthropic|claude|chatgpt|gemini|deepmind|llm|large language model|agentic|ai agent)\b'),
    ('算力、芯片与数据中心', r'\b(nvidia|gpu|tpu|semiconductor|chip|memory|hbm|rubin|blackwell|amd|tsmc|data ?cent(?:er|re)|compute)\b'),
    ('AI安全、监管与人才', r'\b(ai safety|regulat|policy|government|copyright|security|risk|employment|job loss|talent|researcher)\b'),
    ('科技公司与产品应用', r'\b(microsoft|google|meta|amazon|aws|apple|tesla|tiktok|software|enterprise|cloud|advertising)\b'),
    ('美股与科技股交易', r'\b(stock|shares|equity|etf|valuation|earnings|buy|sell|outflow|inflow|investor|market)\b'),
    ('利率、债券与宏观政策', r'\b(bond|yield|interest rate|inflation|federal reserve|\bfed\b|econom|tariff|treasury|dollar|trade war)\b'),
    ('加密资产与数字金融', r'\b(bitcoin|ethereum|crypto|blockchain|stablecoin)\b'),
]

ENTITY_RULES = [
    ('OpenAI', r'\bopenai\b|\bchatgpt\b'),
    ('Anthropic', r'\banthropic\b|\bclaude\b'),
    ('NVIDIA', r'\bnvidia\b|\brubin\b|\bblackwell\b'),
    ('Google / DeepMind', r'\bgoogle\b|\bdeepmind\b|\bgemini\b'),
    ('Microsoft', r'\bmicrosoft\b|\bazure\b'),
    ('Meta', r'\bmeta\b|\bllama\b'),
    ('Amazon / AWS', r'\bamazon\b|\baws\b'),
    ('Apple', r'\bapple\b'),
    ('Tesla / xAI', r'\btesla\b|\bxai\b|\belon musk\b'),
    ('DeepSeek', r'\bdeepseek\b'),
    ('阿里巴巴', r'\balibaba\b|\bqwen\b'),
    ('AMD', r'\bamd\b'),
    ('台积电', r'\btsmc\b'),
]

CATEGORY_TAKEAWAY = {
    'AI技术研究': '整体主线是模型能力竞争、研究人才流动与安全治理。',
    'AI应用与科技': '整体主线是AI产品落地、算力迭代与科技公司商业化。',
    '投资策略': '整体主线是风险收益权衡、科技资产交易与组合调整。',
    '宏观与市场': '整体主线是宏观政策、市场风险偏好与AI主题交易。',
}

def _clean_news_text(value):
    value = html.unescape(str(value or '')).replace('\xa0', ' ')
    return re.sub(r'\s+', ' ', value).strip()

def _zh_join(items):
    items = list(items)
    if not items:
        return ''
    if len(items) == 1:
        return items[0]
    return '、'.join(items[:-1]) + '和' + items[-1]

def build_local_summary(cat_name, posts):
    """Create a stable Chinese digest from the retrieved evidence.

    This is deliberately extractive: it reports recurring themes, named entities
    and the accounts with the most related coverage, without inventing opinions.
    """
    if not posts:
        return '过去24小时暂无足够的新动态。'

    unique = {}
    account_counts = Counter()
    account_names = {}
    for post in posts:
        post['title'] = _clean_news_text(post.get('title'))
        post['desc'] = _clean_news_text(post.get('desc'))
        title_key = re.sub(r'\W+', '', post['title'].lower())[:180]
        unique.setdefault(title_key or str(len(unique)), post)
        handle = str(post.get('handle') or '').strip()
        if handle:
            account_counts[handle] += 1
            account_names[handle] = str(post.get('display_name') or handle).strip()

    texts = [f"{p.get('title', '')} {p.get('desc', '')}".lower() for p in unique.values()]
    theme_counts = Counter()
    entity_counts = Counter()
    for text in texts:
        for label, pattern in THEME_RULES:
            if re.search(pattern, text, re.I):
                theme_counts[label] += 1
        for label, pattern in ENTITY_RULES:
            if re.search(pattern, text, re.I):
                entity_counts[label] += 1

    themes = [label for label, count in theme_counts.most_common(3) if count >= 2]
    entities = [label for label, count in entity_counts.most_common(3) if count >= 2]
    active = [account_names[h] for h, _ in account_counts.most_common(2)]

    parts = [f'过去24小时共收录{len(posts)}条相关动态。']
    if themes:
        parts.append(f'讨论主要集中在{_zh_join(themes)}。')
    else:
        parts.append(f'内容围绕{cat_name}的最新行业与市场变化展开。')
    if entities:
        parts.append(f'高频对象包括{_zh_join(entities)}。')
    if active:
        parts.append(f'{_zh_join(active)}相关报道较多。')
    parts.append(CATEGORY_TAKEAWAY.get(cat_name, '整体反映行业关注点仍在快速变化。'))
    summary = ''.join(parts)
    return summary if len(summary) <= 180 else summary[:179].rstrip('，；。') + '。'

# ── main ─────────────────────────────────────────────────────────────

def main():
    print('=== refresh_kol_tweets.py start ===')
    following = load_following()
    cat_map   = build_cat_map(following)

    all_count = sum(len(v) for v in cat_map.values())
    print(f'  {all_count} accounts, {len(cat_map)} categories')

    output_cats  = []
    total_snippets = 0

    for mc in META_CATS:
        cat_name = mc['name']
        accs     = cat_map.get(cat_name, [])
        if not accs:
            continue

        print(f'\n--- {cat_name} ({len(accs)} accounts) ---')
        posts    = fetch_news_for_category(cat_name, accs)
        n_snip   = len(posts)
        total_snippets += n_snip

        summary = ''
        if posts:
            print(f'  Building local digest for {cat_name} ({n_snip} posts)…')
            summary = build_local_summary(cat_name, posts)
            if summary:
                print(f'  Summary: {summary[:80]}…')
            else:
                raise RuntimeError(f'{cat_name}: posts exist but summary is empty')

        output_cats.append({
            'name':        cat_name,
            'color':       mc['color'],
            'summary':     summary,
            'summary_method': 'local-theme-entity-v1',
            'tweet_count': n_snip,
            'accounts':    [{'handle': a['handle'],
                             'display_name': a.get('display_name', a['handle'])}
                            for a in accs],
            'posts':       posts,   # 过去 24 小时的新闻流水（供二级页面展示）
        })

    output = {
        'last_updated':   now_ts(),
        'has_tweets':     total_snippets > 0,
        'data_source':    'Google/Bing News RSS (24h)',
        'summary_method': 'local-theme-entity-v1',
        'total_accounts': all_count,
        'categories':     output_cats,
    }

    out_path = os.path.join(REPO_ROOT, 'data', 'twitter_kol_summary.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'\n  Total snippets: {total_snippets}')
    print(f'  Written: {out_path}')
    print('=== done ===')

if __name__ == '__main__':
    main()
