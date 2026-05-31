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
  4. Per category: summarise with GPT-4o-mini (GitHub Models)
  5. Write data/twitter_kol_summary.json

Env vars:
  GITHUB_TOKEN  — auto-injected (for GPT-4o-mini)
"""
import os, json, re, datetime, time, urllib.parse, requests
import xml.etree.ElementTree as ET

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '').strip()
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

def _parse_rss_items(xml_text, count):
    """Parse RSS XML and return list of 'title — desc' strings."""
    snippets = []
    try:
        root = ET.fromstring(xml_text)
        for item in root.findall('.//item')[:count]:
            title = (item.findtext('title') or '').strip()
            desc  = (item.findtext('description') or '').strip()
            desc  = re.sub(r'<[^>]+>', ' ', desc)
            desc  = re.sub(r'\s+', ' ', desc).strip()[:200]
            if title:
                snippets.append(f'{title} — {desc}' if desc else title)
    except Exception as e:
        pass
    return snippets

def _fetch_google_news(display_name, handle, count=4):
    """Google News RSS — public feed, no API key, accessible from cloud IPs."""
    q   = urllib.parse.quote(f'"{display_name}"')
    url = f'https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en'
    try:
        r = requests.get(url, headers={'User-Agent': UA,
                                       'Accept': 'application/rss+xml, text/xml, */*'},
                         timeout=15)
        print(f'    [GNews] HTTP {r.status_code} ct={r.headers.get("Content-Type","?")[:30]}')
        if r.status_code == 200:
            items = _parse_rss_items(r.text, count)
            return items
    except Exception as e:
        print(f'    [GNews] {display_name}: {e}')
    return []

def _fetch_bing_news(display_name, handle, count=4):
    """Bing News RSS — fallback."""
    q   = urllib.parse.quote(f'"{display_name}"')
    url = f'https://www.bing.com/news/search?q={q}&format=rss&count={count}'
    try:
        r = requests.get(url, headers={'User-Agent': UA}, timeout=12)
        print(f'    [Bing]  HTTP {r.status_code} ct={r.headers.get("Content-Type","?")[:30]}')
        if r.status_code == 200:
            return _parse_rss_items(r.text, count)
    except Exception as e:
        print(f'    [Bing]  {display_name}: {e}')
    return []

def _news_snippets(display_name, handle, count=4):
    """Try Google News first, then Bing."""
    items = _fetch_google_news(display_name, handle, count)
    if not items:
        items = _fetch_bing_news(display_name, handle, count)
    return items

def fetch_news_for_category(cat_name, accounts):
    """
    Fetch news snippets for up to 6 prominent accounts in a category.
    Returns {handle: [snippet, ...]}
    """
    results = {}
    for acc in accounts[:6]:
        handle       = acc['handle']
        display_name = acc.get('display_name', handle)
        snippets     = _news_snippets(display_name, handle, count=4)
        if snippets:
            results[handle] = snippets
            print(f'  ✓ @{handle}: {len(snippets)} snippets')
        else:
            print(f'  ✗ @{handle}: no results')
        time.sleep(0.5)
    return results

# ── AI summarisation ─────────────────────────────────────────────────

def ai_summarise_category(cat_name, news_by_handle):
    """Use GPT-4o-mini to summarise news snippets for a category."""
    if not GITHUB_TOKEN:
        return ''
    lines = []
    for handle, snippets in news_by_handle.items():
        for s in snippets:
            lines.append(f'[@{handle}] {s[:250]}')
    if not lines:
        return ''

    sample = '\n'.join(lines[:60])
    prompt = (
        f'以下是"{cat_name}"分类下多位意见领袖的最新新闻报道或引用摘要'
        f'（共{len(lines)}条，来源：Bing新闻）：\n\n'
        f'{sample}\n\n'
        f'请用3-5句中文总结这批意见领袖近期关注的核心主题与主要观点，要求：\n'
        f'① 聚焦共同关注点，如有具体观点可点名说明\n'
        f'② 涉及AI技术、市场、投资趋势等主要议题要提及\n'
        f'③ 客观中性，不超过180字\n\n'
        f'输出（仅返回JSON，不要任何解释）：\n'
        f'{{"summary":"3-5句中文观点概括"}}'
    )
    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={'Authorization': f'Bearer {GITHUB_TOKEN}',
                     'Content-Type':  'application/json'},
            json={'model':       'gpt-4o-mini',
                  'messages':    [{'role': 'user', 'content': prompt}],
                  'max_tokens':  500,
                  'temperature': 0.3},
            timeout=30)
        r.raise_for_status()
        raw = r.json()['choices'][0]['message']['content'].strip()
        m   = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            return json.loads(m.group()).get('summary', '').strip()
    except Exception as e:
        print(f'  [AI] {cat_name}: {e}')
    return ''

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
        news     = fetch_news_for_category(cat_name, accs)
        n_snip   = sum(len(v) for v in news.values())
        total_snippets += n_snip

        summary = ''
        if news:
            print(f'  Summarising {cat_name} ({n_snip} snippets)…')
            summary = ai_summarise_category(cat_name, news)
            if summary:
                print(f'  Summary: {summary[:80]}…')

        output_cats.append({
            'name':        cat_name,
            'color':       mc['color'],
            'summary':     summary,
            'tweet_count': n_snip,
            'accounts':    [{'handle': a['handle'],
                             'display_name': a.get('display_name', a['handle'])}
                            for a in accs],
        })

    output = {
        'last_updated':   now_ts(),
        'has_tweets':     total_snippets > 0,
        'data_source':    'Bing News RSS',
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
