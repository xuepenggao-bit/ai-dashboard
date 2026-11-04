"""Economic Net's original-currency, individual broker forecast excerpts.

These are the provider's broker-detail rows, not its consensus-average table
and not independently verified PDFs.  Its dates are forecast update dates.
No EPS or share-count arithmetic is used to manufacture net profit.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from html.parser import HTMLParser
import math
import re


def hk_url(code):
    value = str(code or "")
    if not re.fullmatch(r"\d{1,5}", value) or not 0 < int(value) <= 99999:
        raise ValueError("HK code must be one to five digits")
    return "https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=" + str(int(value))


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.stack, self.title = [], [], []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag == "table":
            table = {"rows": [], "row": None, "cell": None}
            self.tables.append(table)
            self.stack.append(table)
        elif self.stack:
            table = self.stack[-1]
            if tag == "tr":
                table["row"], table["cell"] = [], None
            elif tag in ("td", "th") and table["row"] is not None:
                table["cell"] = []
            elif tag == "br" and table["cell"] is not None:
                table["cell"].append(" ")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if not self.stack:
            return
        table = self.stack[-1]
        if tag in ("td", "th") and table["cell"] is not None:
            table["row"].append(re.sub(r"\s+", " ", "".join(table["cell"])).strip())
            table["cell"] = None
        elif tag == "tr" and table["row"] is not None:
            if table["row"]:
                table["rows"].append(table["row"])
            table["row"], table["cell"] = None, None
        elif tag == "table":
            self.stack.pop()

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        if self.stack and self.stack[-1]["cell"] is not None:
            self.stack[-1]["cell"].append(data)


def _money(text):
    text = re.sub(r"\s+", "", str(text or "")).replace(",", "").replace("，", "")
    if not text or text in ("-", "--", "—", "N/A"):
        return None
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", text):
        return None
    value = float(text)
    return value if math.isfinite(value) else None


def _profit_unit(header):
    compact = re.sub(r"\s+", "", header)
    if any(x in compact for x in ("每股", "EPS", "每股盈利")):
        return None
    if not any(x in compact for x in ("纯利", "純利", "净利润", "淨利潤")):
        return None
    currencies = [("CNY", ("人民币", "人民幣", "CNY", "RMB")),
                  ("HKD", ("港元", "港币", "港幣", "HKD")),
                  ("USD", ("美元", "美金", "USD", "US$"))]
    matches = [code for code, names in currencies if any(name in compact for name in names)]
    if len(matches) != 1:
        return None
    if "百万" in compact or "百萬" in compact:
        scale = 1e6
    elif "亿元" in compact or "億元" in compact:
        scale = 1e8
    elif "千元" in compact or "千美元" in compact or "千港元" in compact:
        scale = 1e3
    else:
        return None  # Unknown scale must not silently mean one million.
    return matches[0], scale / 1e8


def parse_hk_forecasts(raw_html, code, target_year, as_of=None):
    """Return all valid current-target-year broker detail rows.

    The caller owns latest-N selection and aggregation. Fiscal years remain
    exactly as labelled by the provider; no calendar year-end is invented.
    """
    url = hk_url(code)
    year = int(target_year)
    if not 2000 <= year <= 2100:
        raise ValueError("Invalid forecast year")
    as_of = dt.date.fromisoformat(as_of or dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat())
    parser = _Tables()
    parser.feed(str(raw_html or ""))
    title = "".join(parser.title).strip()
    issuer = re.match(r"^(\d{1,5})\s+", title)
    if not issuer or int(issuer.group(1)) != int(code):
        raise ValueError("Forecast page issuer does not match requested HK code")

    records, conflicts = {}, set()
    for table in parser.tables:
        header = None
        for row in table["rows"]:
            if any("财政年度" in x or "財政年度" in x for x in row) and any("证券商" in x or "證券商" in x for x in row) and any("更新日期" in x for x in row):
                header = row
                break
        if header is None:
            continue  # In particular, skip the aggregate consensus table.
        profit_columns = [(i, _profit_unit(text)) for i, text in enumerate(header)]
        profit_columns = [(i, unit) for i, unit in profit_columns if unit]
        if len(profit_columns) != 1:
            continue
        profit_index, (currency, yi_factor) = profit_columns[0]
        year_index = next(i for i, x in enumerate(header) if "财政年度" in x or "財政年度" in x)
        broker_index = next(i for i, x in enumerate(header) if "证券商" in x or "證券商" in x)
        for row in table["rows"]:
            # Target-price header has colspan=2; the update date is the final
            # data cell, not the header's numerical column index.
            if len(row) < max(year_index, profit_index, broker_index) + 2:
                continue
            if row[year_index] != str(year):
                continue
            value, broker = _money(row[profit_index]), row[broker_index].strip()
            if value is None or not broker or broker in ("--", "—", "-"):
                continue
            try:
                date = dt.datetime.strptime(row[-1].strip(), "%d/%m/%Y").date()
            except ValueError:
                continue
            if date > as_of:
                continue
            fingerprint = "|".join((str(int(code)), broker, date.isoformat(), str(year)))
            ident = "etnet-hk-" + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:20]
            record = {
                "id": ident, "broker": broker,
                "title": f"经济通券商盈利预测摘录 · {broker} · {year}年",
                "publishedAt": date.isoformat(), "forecastYear": year,
                "currency": currency, "profitYi": value * yi_factor,
                "url": url, "sourceType": "provider_broker_detail",
                "dateType": "provider_updated_at",
                "periodBasis": "fiscal_year_as_labelled",
                "sourceNote": "日期为经济通所列券商预测更新日，非逐份核验的原始研报发布日期；金额为提供商所列纯利/亏损。",
            }
            if ident in records and records[ident] != record:
                conflicts.add(ident)
            else:
                records[ident] = record
    for ident in conflicts:
        records.pop(ident, None)
    return sorted(records.values(), key=lambda r: (r["publishedAt"], r["broker"]), reverse=True)
