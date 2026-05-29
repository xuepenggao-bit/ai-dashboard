#!/usr/bin/env python3
"""
Refresh AI趋势数据：Hyperscaler Capex / OpenAI & Anthropic ARR / 美股7姐妹PE。

后台 AI 联网抓取：DuckDuckGo 搜索最新公开信息 + GPT-4o-mini(GitHub Models) 提取
结构化数字，写入 data/ai_trend.json。失败时保留现有数据，不破坏。

注意：财务数字由 AI 从搜索摘要提取，可能有误，请以公司财报为准。
依赖：requests, duckduckgo_search
环境：GITHUB_TOKEN（GitHub Actions 自动注入，用于 GPT-4o-mini）
"""
import os, json, re, datetime, requests

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '').strip()
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT    = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))
OUT          = os.path.join(REPO_ROOT, 'data', 'ai_trend.json')

def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')

def ddg_search(query, n=5):
    """DuckDuckGo 文本搜索，返回标题+摘要拼接"""
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=n))
        out = '\n'.join(f"- {r.get('title','')}: {r.get('body','')}" for r in results)
        print(f'  [DDG] "{query[:50]}" -> {len(results)} 条')
        return out
    except Exception as e:
        print(f'  [DDG] "{query[:50]}" 失败: {e}')
        return ''

def main():
    print('=== refresh_ai_trend.py start ===')
    # 读现有 JSON 作为基准（AI 失败时保留原值）
    try:
        with open(OUT, encoding='utf-8') as f:
            base = json.load(f)
    except Exception:
        base = {}

    # ① 联网搜索最新信息
    queries = [
        'Microsoft Google Amazon Meta capex 2026 guidance total billion hyperscaler',
        'Anthropic ARR annualized revenue run rate 2026 latest billion',
        'OpenAI ARR annualized revenue run rate 2026 billion',
        'Magnificent 7 stocks median trailing PE ratio 2026',
    ]
    context = '\n\n'.join(f'【查询：{q}】\n{ddg_search(q)}' for q in queries)
    if not context.strip():
        print('搜索无结果，保留现有数据，结束'); return

    if not GITHUB_TOKEN:
        print('无 GITHUB_TOKEN，无法 AI 提取，保留现有数据'); return

    # ② GPT-4o-mini 提取结构化数字
    prompt = (
        '以下是关于AI产业资本支出(Capex)、AI公司ARR、美股七姐妹PE的最新网络搜索结果：\n\n'
        f'{context[:6500]}\n\n'
        '请从中提取最新数据，输出JSON。单位统一为"$亿"（十亿美元×10，例：$715B=7150，$47B=470）：\n'
        '{\n'
        '  "hyperscaler_capex_2026e_yi": <微软+谷歌+亚马逊+Meta 2026年capex合计，$亿>,\n'
        '  "hyperscaler_yoy_pct": <同比增速百分数>,\n'
        '  "hyperscaler_detail": "<各公司明细，如 MSFT $190B · GOOGL $190B · AMZN $200B · META $135B>",\n'
        '  "mag7_pe_median": <美股七姐妹PE中位数>,\n'
        '  "arr_anthropic_latest_yi": <Anthropic最新ARR，$亿>,\n'
        '  "arr_openai_latest_yi": <OpenAI最新ARR，$亿>\n'
        '}\n'
        '只返回JSON，数字用阿拉伯数字（不带$和单位符号）。无法从搜索结果确定的字段直接省略该键。'
    )
    try:
        r = requests.post(
            'https://models.inference.ai.azure.com/chat/completions',
            headers={'Authorization': f'Bearer {GITHUB_TOKEN}', 'Content-Type': 'application/json'},
            json={'model': 'gpt-4o-mini',
                  'messages': [{'role': 'user', 'content': prompt}],
                  'max_tokens': 500, 'temperature': 0.1},
            timeout=40)
        r.raise_for_status()
        raw = r.json()['choices'][0]['message']['content']
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        ext = json.loads(m.group()) if m else {}
        print('  [AI] 提取:', json.dumps(ext, ensure_ascii=False))
    except Exception as e:
        print(f'  [AI] 提取失败: {e}，保留现有数据'); return

    # ③ 合并到基准 JSON（仅更新成功提取的字段，带合理性范围校验）
    def _num(v):
        try: return float(v)
        except: return None

    v = _num(ext.get('hyperscaler_capex_2026e_yi'))
    if v and 3000 <= v <= 15000: base['hyperscaler_capex_2026e_yi'] = int(v)
    v = _num(ext.get('hyperscaler_yoy_pct'))
    if v and 0 <= v <= 300: base['hyperscaler_yoy_pct'] = round(v, 1)
    if ext.get('hyperscaler_detail'): base['hyperscaler_detail'] = str(ext['hyperscaler_detail'])[:120]
    v = _num(ext.get('mag7_pe_median'))
    if v and 10 <= v <= 100: base['mag7_pe_median'] = round(v, 1)

    # ARR：把最新值追加/更新到时间线末尾（按月去重）
    an = _num(ext.get('arr_anthropic_latest_yi'))
    oa = _num(ext.get('arr_openai_latest_yi'))
    if an and oa and 0 < an < 2000 and 0 < oa < 2000:
        lbl = datetime.datetime.now().strftime('%Y-%m')
        base.setdefault('arr_labels', []); base.setdefault('arr_anthropic', []); base.setdefault('arr_openai', [])
        if base['arr_labels'] and base['arr_labels'][-1] == lbl:
            base['arr_anthropic'][-1] = int(an); base['arr_openai'][-1] = int(oa)
        else:
            base['arr_labels'].append(lbl); base['arr_anthropic'].append(int(an)); base['arr_openai'].append(int(oa))
            for k in ('arr_labels', 'arr_anthropic', 'arr_openai'):
                base[k] = base[k][-10:]   # 最多保留10个点

    base['updated'] = now_ts()
    base['note'] = 'AI联网抓取整理（DuckDuckGo + GPT-4o-mini），财务数字请以公司财报为准'

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(base, f, ensure_ascii=False, indent=2)
    print('  写入:', OUT)
    print('=== done ===')

if __name__ == '__main__':
    main()
