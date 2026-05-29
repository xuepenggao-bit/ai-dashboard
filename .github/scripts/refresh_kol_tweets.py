#!/usr/bin/env python3
"""
Refresh X KOL (Key Opinion Leader) tweet summaries.

Pipeline:
  1. Load account list from data/twitter_following.json
  2. Group accounts into 5 meta-categories
  3. Fetch latest 5 tweets per account via twikit (uses X cookies)
  4. Per category: summarise collected tweets with GPT-4o-mini
  5. Write data/twitter_kol_summary.json

Credentials (GitHub Secrets):
  TWITTER_AUTH_TOKEN  — value of auth_token cookie from x.com
  TWITTER_CT0         — value of ct0 cookie from x.com
  GITHUB_TOKEN        — auto-injected by GitHub Actions (for GPT-4o-mini)

If Twitter credentials are absent the script still runs and writes the
account-profile-only JSON (no tweet summaries), so the UI shows at least
the grouped account badges.
"""
import os, json, re, asyncio, datetime, requests

# ── credentials ────────────────────────────────────────────────────
TWITTER_AUTH_TOKEN = os.environ.get('TWITTER_AUTH_TOKEN', '').strip()
TWITTER_CT0        = os.environ.get('TWITTER_CT0', '').strip()
GITHUB_TOKEN       = os.environ.get('GITHUB_TOKEN', '').strip()
SCRIPT_DIR         = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT          = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))

# ── meta-category mapping ───────────────────────────────────────────
META_CATS = [
    {
        'name': 'AI技术研究',
        'color': '#7c3aed',
        'topics': ['AI行业/学术', 'AI行业/Claude Code', 'AI行业/HuggingFace',
                   'AI行业/DeepMind', 'AI行业/谷歌', 'AI行业/Anthropic',
                   'AI行业/SSI', 'AI行业/安全', 'AI行业/伦理', 'AI行业',
                   'AI行业/半导体', 'AI行业/投资'],
    },
    {
        'name': 'AI应用与动态',
        'color': '#0369a1',
        'topics': ['AI工具', 'AI/提示工程', 'AI行业分析', 'AI干货/投资',
                   'AI芯片/资本市场', 'AI/投资工具', 'AI/投资',
                   '前沿科技/资本'],
    },
    {
        'name': '投资策略',
        'color': '#059669',
        'topics': ['投资理念', '投资理念/量化', '投资理念/宏观', '投资理念/交易',
                   '投资理念/教育', '投资', '价值投资', '小盘股投资',
                   '投资/科技股', '投资管理', '投资/加密/宏观',
                   '加密货币/AI', '加密货币/金融'],
    },
    {
        'name': '宏观与市场',
        'color': '#dc2626',
        'topics': ['宏观经济', '市场策略', '估值/金融', '资产管理'],
    },
    {
        'name': '科技行业',
        'color': '#0891b2',
        'topics': ['科技', '科技行业研究', '科技产业/苹果', 'AI行业/半导体研究'],
    },
]

# TrendForce's topic is 'AI行业/半导体' — it fits AI技术研究 above,
# but we want it in 科技行业; handle explicit overrides here:
HANDLE_OVERRIDE = {
    'trendforce':    '科技行业',
    '168X_Fortune':  'AI应用与动态',
}

def get_meta_cat(handle, topic):
    if handle in HANDLE_OVERRIDE:
        return HANDLE_OVERRIDE[handle]
    for mc in META_CATS:
        if topic in mc['topics']:
            return mc['name']
    # Fuzzy fallback
    t = topic.lower()
    if 'ai' in t and '投资' not in t:
        return 'AI技术研究'
    if '投资' in t or '价值' in t or '交易' in t:
        return '投资策略'
    if '宏观' in t or '市场' in t or '估值' in t:
        return '宏观与市场'
    if '加密' in t:
        return '投资策略'
    if '科技' in t:
        return '科技行业'
    return 'AI应用与动态'  # default

# ── helpers ─────────────────────────────────────────────────────────
def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')

def load_following():
    path = os.path.join(REPO_ROOT, 'data', 'twitter_following.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def build_cat_map(following):
    """Returns {meta_cat_name: [account_dict, ...]}"""
    cats = {mc['name']: [] for mc in META_CATS}
    for acc in following.get('accounts', []):
        if not acc.get('enabled', True):
            continue
        meta = get_meta_cat(acc['handle'], acc.get('topic', ''))
        if meta in cats:
            cats[meta].append(acc)
    return cats

# ── tweet fetching via twikit ────────────────────────────────────────
async def _fetch_tweets_twikit(accounts):
    """
    Fetch latest 5 tweets for each account using twikit (unofficial X API).
    Returns {handle: [tweet_text, ...]}
    """
    try:
        from twikit import Client
    except ImportError:
        print('[twikit] not installed — skipping tweet fetch')
        return {}

    if not TWITTER_AUTH_TOKEN or not TWITTER_CT0:
        print('[twikit] TWITTER_AUTH_TOKEN / TWITTER_CT0 not set — skipping')
        return {}

    client = Client('en-US')
    client.set_cookies({'auth_token': TWITTER_AUTH_TOKEN, 'ct0': TWITTER_CT0})

    results = {}
    for acc in accounts:
        handle = acc['handle']
        try:
            user   = await client.get_user_by_screen_name(handle)
            tweets = await user.get_tweets('Tweets', count=5)
            texts  = [t.text for t in tweets if t.text][:5]
            if texts:
                results[handle] = texts
                print(f'  [twikit] @{handle}: {len(texts)} tweets fetched')
            await asyncio.sleep(1.0)   # gentle rate limiting
        except Exception as e:
            print(f'  [twikit] @{handle}: {e}')
            await asyncio.sleep(2.0)

    return results

# ── AI summarisation ─────────────────────────────────────────────────
def ai_summarise_category(cat_name, accounts_with_tweets):
    """
    Use GPT-4o-mini (via GitHub Models) to summarise all collected tweets
    for a meta-category.  Returns a summary string.
    """
    if not GITHUB_TOKEN:
        return ''

    lines = []
    for handle, tweets in accounts_with_tweets.items():
        for t in tweets:
            lines.append(f'@{handle}: {t[:200]}')
    if not lines:
        return ''

    sample = '\n'.join(lines[:80])
    prompt = (
        f'以下是"{cat_name}"分类下多位X（Twitter）意见领袖的最新推文（共{len(lines)}条）：\n\n'
        f'{sample}\n\n'
        f'请用3-5句中文总结这批意见领袖当前关注的核心主题与主流观点，要求：\n'
        f'① 聚焦共同关注点和代表性观点，忽略无实质内容的推文\n'
        f'② 如涉及具体公司/技术/政策可点名\n'
        f'③ 客观中性，不超过180字\n\n'
        f'输出（仅返回 JSON，不要任何解释）：\n'
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
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            return json.loads(m.group()).get('summary', '').strip()
    except Exception as e:
        print(f'  [AI] {cat_name} summary failed: {e}')
    return ''

# ── main ─────────────────────────────────────────────────────────────
async def main():
    print('=== refresh_kol_tweets.py start ===')
    following  = load_following()
    cat_map    = build_cat_map(following)

    # Collect all enabled accounts in one list for tweet fetching
    all_accounts = []
    for accs in cat_map.values():
        all_accounts.extend(accs)

    print(f'  {len(all_accounts)} accounts loaded, {len(cat_map)} categories')

    # Fetch tweets
    tweet_map = await _fetch_tweets_twikit(all_accounts)
    has_tweets = bool(tweet_map)
    print(f'  Tweets fetched for {len(tweet_map)} accounts')

    # Build output categories
    output_cats = []
    for mc in META_CATS:
        cat_name = mc['name']
        accs     = cat_map.get(cat_name, [])
        if not accs:
            continue

        # Collect tweets for this category
        cat_tweets = {}
        total_tweets = 0
        for acc in accs:
            h = acc['handle']
            if h in tweet_map:
                cat_tweets[h] = tweet_map[h]
                total_tweets += len(tweet_map[h])

        # AI summary
        summary = ''
        if cat_tweets:
            print(f'  Summarising {cat_name} ({total_tweets} tweets)…')
            summary = ai_summarise_category(cat_name, cat_tweets)

        output_cats.append({
            'name':        cat_name,
            'color':       mc['color'],
            'summary':     summary,
            'tweet_count': total_tweets,
            'accounts':    [{'handle': a['handle'],
                             'display_name': a.get('display_name', a['handle'])}
                            for a in accs],
        })

    output = {
        'last_updated':   now_ts(),
        'has_tweets':     has_tweets,
        'total_accounts': len(all_accounts),
        'categories':     output_cats,
    }

    out_path = os.path.join(REPO_ROOT, 'data', 'twitter_kol_summary.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'  Written: {out_path}')
    print('=== done ===')

if __name__ == '__main__':
    asyncio.run(main())
