"""Finance MCP server — scrapes BofA, SoFi, and Capital One via Camoufox."""

from __future__ import annotations

import json
import re

from mcp.server.fastmcp import FastMCP

from banks import ALL_BANKS, bofa, capitalone, sofi
from banks.shared import BankSessionExpiredError, get_bank_page

mcp = FastMCP("finance")


# ── Helpers ─────────────────────────────────────────────────────────────────


def _bank_error(bank: str, e: Exception) -> dict:
    return {
        "bank": bank,
        "error": str(e),
        "sessionExpired": isinstance(e, BankSessionExpiredError),
    }


def _resolve_banks(bank: str | None) -> list[str]:
    if bank:
        if bank not in ALL_BANKS:
            raise ValueError(f"Unknown bank: {bank}. Choose from: {', '.join(ALL_BANKS)}")
        return [bank]
    return list(ALL_BANKS)


_SCRAPE_BALANCES = {
    "sofi": sofi.scrape_balances,
    "bofa": bofa.scrape_balances,
    "capitalone": capitalone.scrape_balances,
}

_SCRAPE_TRANSACTIONS = {
    "sofi": sofi.scrape_transactions,
    "bofa": bofa.scrape_transactions,
    "capitalone": capitalone.scrape_transactions,
}


# ── Read tools ──────────────────────────────────────────────────────────────


@mcp.tool()
def get_balances(bank: str | None = None) -> str:
    """Get account balances across all banks (SoFi, BofA, Capital One) via browser scraping.
    Optionally filter to a single bank: 'sofi', 'bofa', or 'capitalone'."""
    banks = _resolve_banks(bank)
    results: list[dict] = []
    errors: list[dict] = []

    for b in banks:
        try:
            page = get_bank_page(b)
            results.extend(_SCRAPE_BALANCES[b](page))
        except Exception as e:
            errors.append(_bank_error(b, e))

    return json.dumps({"data": results, "errors": errors}, indent=2)


@mcp.tool()
def get_transactions(
    bank: str | None = None,
    days_back: int = 30,
    account_name: str | None = None,
) -> str:
    """List recent transactions across all banks via browser scraping.

    Optionally filter by bank, days of history, or account name (regex).
    """
    banks = _resolve_banks(bank)
    results: list[dict] = []
    errors: list[dict] = []

    for b in banks:
        try:
            page = get_bank_page(b)
            results.extend(_SCRAPE_TRANSACTIONS[b](page, days_back))
        except Exception as e:
            errors.append(_bank_error(b, e))

    if account_name:
        pat = re.compile(account_name, re.I)
        results = [t for t in results if pat.search(t["account_name"])]

    results.sort(key=lambda t: t["date"], reverse=True)
    return json.dumps({"data": results, "errors": errors}, indent=2)


@mcp.tool()
def get_credit_due() -> str:
    """Get credit card due dates, statement balances, and minimum payments (BofA + Capital One)."""
    results: list[dict] = []
    errors: list[dict] = []

    credit_scrapers = [
        ("bofa", bofa.scrape_credit_due),
        ("capitalone", capitalone.scrape_credit_due),
    ]
    for b, scraper in credit_scrapers:
        try:
            page = get_bank_page(b)
            due = scraper(page)
            if due:
                results.append(due)
        except Exception as e:
            errors.append(_bank_error(b, e))

    return json.dumps({"data": results, "errors": errors}, indent=2)


@mcp.tool()
def spending_summary(days_back: int = 30, account_name: str | None = None) -> str:
    """Compute spending summary from scraped transactions.
    Categories may be limited since bank UIs don't always categorize transactions."""
    # Reuse transaction scraping
    raw = json.loads(get_transactions(days_back=days_back, account_name=account_name))
    transactions = raw["data"]
    errors = raw["errors"]

    summary = _compute_summary(transactions)
    return json.dumps({"data": summary, "errors": errors}, indent=2)


@mcp.tool()
def get_recurring() -> str:
    """Detect recurring charges by analyzing 90 days of transaction history.
    Uses heuristic pattern matching (repeated merchant + similar amount + regular interval)."""
    raw = json.loads(get_transactions(days_back=90))
    transactions = raw["data"]
    errors = raw["errors"]

    recurring = _detect_recurring(transactions)
    return json.dumps({"data": recurring, "errors": errors}, indent=2)


# ── Write tools ─────────────────────────────────────────────────────────────


@mcp.tool()
def sofi_transfer(to_account: str, amount: float, memo: str | None = None) -> str:
    """Transfer money from SoFi checking account.
    to_account: 'savings' or an external account name. Requires active browser session."""
    try:
        page = get_bank_page("sofi")
        result = sofi.transfer(page, to_account, amount, memo)
        return json.dumps(result, indent=2)
    except Exception as e:
        expired = isinstance(e, BankSessionExpiredError)
        return json.dumps({"error": str(e), "sessionExpired": expired})


@mcp.tool()
def bofa_transfer(from_account: str, to_account: str, amount: float) -> str:
    """Transfer money between Bank of America accounts.
    Requires active browser session."""
    try:
        page = get_bank_page("bofa")
        result = bofa.transfer(page, from_account, to_account, amount)
        return json.dumps(result, indent=2)
    except Exception as e:
        expired = isinstance(e, BankSessionExpiredError)
        return json.dumps({"error": str(e), "sessionExpired": expired})


@mcp.tool()
def bofa_pay_credit_card(amount: str = "statement", from_account: str = "checking") -> str:
    """Pay Bank of America credit card from BofA checking.
    amount: 'statement', 'minimum', or a dollar amount like '50.00'.
    Requires active browser session."""
    try:
        page = get_bank_page("bofa")
        result = bofa.pay_credit_card(page, amount, from_account)
        return json.dumps(result, indent=2)
    except Exception as e:
        expired = isinstance(e, BankSessionExpiredError)
        return json.dumps({"error": str(e), "sessionExpired": expired})


@mcp.tool()
def capitalone_pay(amount: str = "statement", from_bank: str = "external") -> str:
    """Pay Capital One credit card.
    amount: 'statement', 'minimum', or a dollar amount like '50.00'.
    Requires active browser session."""
    try:
        page = get_bank_page("capitalone")
        result = capitalone.pay(page, amount, from_bank)
        return json.dumps(result, indent=2)
    except Exception as e:
        expired = isinstance(e, BankSessionExpiredError)
        return json.dumps({"error": str(e), "sessionExpired": expired})


# ── Aggregate computation ──────────────────────────────────────────────────


def _compute_summary(transactions: list[dict]) -> dict:
    total_spent = 0.0
    total_income = 0.0
    by_category: dict[str, float] = {}
    by_account: dict[str, float] = {}

    for tx in transactions:
        if tx.get("pending"):
            continue
        amt = tx.get("amount", 0)
        if amt > 0:
            total_spent += amt
        else:
            total_income += abs(amt)
        cat = tx.get("category", "Uncategorized")
        by_category[cat] = by_category.get(cat, 0) + amt
        acct = tx.get("account_name", "Unknown")
        by_account[acct] = by_account.get(acct, 0) + amt

    return {
        "total_spent": round(total_spent, 2),
        "total_income": round(total_income, 2),
        "net": round(total_income - total_spent, 2),
        "by_category": by_category,
        "by_account": by_account,
    }


def _detect_recurring(transactions: list[dict]) -> list[dict]:
    from datetime import datetime

    # Group by normalized merchant name
    by_merchant: dict[str, list[dict]] = {}
    for tx in transactions:
        if tx.get("pending"):
            continue
        key = re.sub(r"[^a-z0-9]", "", tx.get("merchant", "").lower())
        if not key:
            continue
        by_merchant.setdefault(key, []).append(tx)

    recurring: list[dict] = []

    for _key, txns in by_merchant.items():
        if len(txns) < 2:
            continue

        # Check amounts are similar (within 10%)
        amounts = [t["amount"] for t in txns]
        avg_amount = sum(amounts) / len(amounts)
        if avg_amount == 0:
            continue
        if not all(abs(a - avg_amount) / avg_amount < 0.1 for a in amounts):
            continue

        # Check intervals are roughly regular
        dates = []
        for t in txns:
            try:
                dates.append(datetime.strptime(t["date"], "%Y-%m-%d").timestamp())
            except (ValueError, KeyError):
                pass
        dates.sort()
        if len(dates) < 2:
            continue

        intervals = [
            (dates[i] - dates[i - 1]) / 86400 for i in range(1, len(dates))
        ]
        avg_interval = sum(intervals) / len(intervals)

        if 6 <= avg_interval <= 8:
            frequency = "weekly"
        elif 13 <= avg_interval <= 16:
            frequency = "biweekly"
        elif 25 <= avg_interval <= 35:
            frequency = "monthly"
        elif 55 <= avg_interval <= 65:
            frequency = "bimonthly"
        elif 85 <= avg_interval <= 100:
            frequency = "quarterly"
        else:
            continue

        latest = max(txns, key=lambda t: t.get("date", ""))
        recurring.append({
            "merchant": latest["merchant"],
            "amount": round(avg_amount, 2),
            "frequency": frequency,
            "last_date": latest["date"],
            "account_name": latest["account_name"],
        })

    recurring.sort(key=lambda r: r["amount"], reverse=True)
    return recurring


if __name__ == "__main__":
    mcp.run(transport="stdio")
