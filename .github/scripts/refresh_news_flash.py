#!/usr/bin/env python3
"""抓取东方财富 7x24 快讯，写入 data/news_flash.json。

前端可直接拉「财经要闻」(np-listapi getNewsByColumns，CORS 放行)，
但 7x24 快讯接口(np-weblist getFastNewsList)被浏览器 CORS 拦截，
故由本脚本在 GitHub Actions 服务端定时抓取、归一化后提交。

依赖：requests。无需任何密钥（GITHUB_TOKEN 仅用于提交）。
"""
import os, json, datetime, requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT  = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))
OUT        = os.path.join(REPO_ROOT, 'data', 'news_flash.json')


def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime('%Y-%m-%d %H:%M')


def main():
    print('=== refresh_news_flash.py start ===')
    url = ('https://np-weblist.eastmoney.com/comm/web/getFastNewsList'
           '?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=1')
    headers = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kuaixun.eastmoney.com/'}
    try:
        r = requests.get(url, headers=headers, timeout=20)
        data = r.json()
    except Exception as e:
        print('fetch failed, keep existing:', e)
        return
    raw = (data.get('data') or {}).get('fastNewsList') or []
    items = []
    for n in raw[:20]:
        code = str(n.get('code', '') or '')
        items.append({
            'title':   n.get('title', ''),
            'summary': n.get('summary', ''),
            'time':    n.get('showTime', ''),
            'url':     ('https://finance.eastmoney.com/a/%s.html' % code) if code else ''
        })
    if not items:
        print('no items parsed, keep existing')
        return
    out = {'updated': now_ts(), 'source': '东方财富 7x24', 'list': items}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('wrote %d items' % len(items))


if __name__ == '__main__':
    main()
