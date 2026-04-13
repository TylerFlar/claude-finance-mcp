from __future__ import annotations

import re
from datetime import datetime, timedelta

from playwright.sync_api import Page

from .shared import (
    check_logged_in,
    parse_dollar_amount,
    parse_transaction_date,
    wait_for_navigation,
)

SOFI_BANKING_URL = "https://www.sofi.com/wealth/app/banking"


# ── Balances ────────────────────────────────────────────────────────────────


def scrape_balances(page: Page) -> list[dict]:
    page.goto(SOFI_BANKING_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    check_logged_in(page, "sofi")

    balances: list[dict] = []

    account_cards = page.locator(
        "[data-testid*='account'], .account-card, "
        "[class*='AccountCard'], [class*='account-tile']"
    )
    count = _safe_count(account_cards)

    if count > 0:
        for i in range(count):
            card = account_cards.nth(i)
            text = _safe_text(card)
            is_checking = bool(re.search(r"checking", text, re.I))
            is_savings = bool(re.search(r"savings", text, re.I))
            if not is_checking and not is_savings:
                continue

            amount_match = re.search(r"\$[\d,]+\.?\d*", text)
            amount = parse_dollar_amount(amount_match.group(0)) if amount_match else None

            balances.append({
                "institution": "SoFi",
                "account_name": "SoFi Checking" if is_checking else "SoFi Savings",
                "type": "checking",
                "current_balance": amount or 0,
                "available_balance": amount,
                "currency": "USD",
            })

    # Fallback: scan page text
    if not balances:
        body_text = _safe_text(page.locator("main, [role='main'], body").first())
        for acct_type in ("Checking", "Savings"):
            m = re.search(
                rf"{acct_type}[\s\S]{{0,100}}?(\$[\d,]+\.\d{{2}})", body_text, re.I
            )
            if m:
                balances.append({
                    "institution": "SoFi",
                    "account_name": f"SoFi {acct_type}",
                    "type": "checking",
                    "current_balance": parse_dollar_amount(m.group(1)) or 0,
                    "available_balance": parse_dollar_amount(m.group(1)),
                    "currency": "USD",
                })

    return balances


# ── Transactions ────────────────────────────────────────────────────────────


def scrape_transactions(page: Page, days_back: int) -> list[dict]:
    # Navigate to activity view
    activity_link = page.locator(
        "a[href*='activity'], a:has-text('Activity'), button:has-text('Activity')"
    ).first()
    try:
        if activity_link.is_visible(timeout=3000):
            activity_link.click()
            wait_for_navigation(page)
        else:
            raise Exception("not visible")
    except Exception:
        page.goto(SOFI_BANKING_URL + "/activity", wait_until="domcontentloaded")
        wait_for_navigation(page)

    check_logged_in(page, "sofi")

    transactions: list[dict] = []
    cutoff = datetime.now() - timedelta(days=days_back)

    rows = page.locator(
        "[data-testid*='transaction'], .transaction-row, "
        "[class*='TransactionRow'], [class*='transaction-item'], "
        "tr[class*='transaction']"
    )
    row_count = _safe_count(rows)

    for i in range(row_count):
        row = rows.nth(i)
        text = _safe_text(row)

        date_str = parse_transaction_date(text)
        if date_str:
            try:
                tx_date = datetime.strptime(date_str, "%Y-%m-%d")
                if tx_date < cutoff:
                    continue
            except ValueError:
                pass

        amount_match = re.search(r"-?\$[\d,]+\.?\d*", text)
        amount = parse_dollar_amount(amount_match.group(0)) if amount_match else None

        merchant = _extract_merchant(text)

        if amount is not None and merchant:
            transactions.append({
                "date": date_str or datetime.now().strftime("%Y-%m-%d"),
                "merchant": merchant,
                "amount": abs(amount),
                "category": "Uncategorized",
                "account_name": "SoFi Checking",
                "pending": bool(re.search(r"pending", text, re.I)),
            })

    return transactions


# ── Transfer ────────────────────────────────────────────────────────────────


def transfer(page: Page, to_account: str, amount: float, memo: str | None) -> dict:
    page.goto(SOFI_BANKING_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    check_logged_in(page, "sofi")

    # Navigate to transfer page
    transfer_link = page.locator(
        "a[href*='transfer'], button:has-text('Transfer')"
    ).first()
    transfer_link.click(timeout=10000)
    wait_for_navigation(page)

    # Select source (checking)
    from_select = page.locator(
        "[data-testid='from-account'], select[name*='from']"
    ).first()
    if from_select.is_visible():
        from_options = from_select.locator("option").all_text_contents()
        from_match = next((o for o in from_options if re.search(r"checking", o, re.I)), None)
        if from_match:
            from_select.select_option(label=from_match)

    # Select destination
    to_select = page.locator(
        "[data-testid='to-account'], select[name*='to']"
    ).first()
    if to_select.is_visible():
        to_options = to_select.locator("option").all_text_contents()
        to_match = next((o for o in to_options if re.search(to_account, o, re.I)), None)
        if to_match:
            to_select.select_option(label=to_match)

    # Enter amount
    amount_input = page.locator(
        "input[name*='amount'], input[type='number']"
    ).first()
    amount_input.fill(f"{amount:.2f}")

    # Memo
    if memo:
        memo_input = page.locator(
            "input[name*='memo'], textarea[name*='memo']"
        ).first()
        if memo_input.is_visible():
            memo_input.fill(memo)

    # Submit
    submit_btn = page.locator(
        "button[type='submit'], button:has-text('Review'), button:has-text('Continue')"
    ).first()
    submit_btn.click()
    wait_for_navigation(page)

    # Confirm
    confirm_btn = page.locator(
        "button:has-text('Confirm'), button:has-text('Submit')"
    ).first()
    try:
        if confirm_btn.is_visible(timeout=5000):
            confirm_btn.click()
            wait_for_navigation(page)
    except Exception:
        pass

    # Extract confirmation
    confirm_text = _safe_text(
        page.locator("[data-testid='confirmation'], .confirmation, .success").first()
    )
    conf_match = re.search(r"\b[A-Z0-9]{6,}\b", confirm_text)

    return {
        "status": "submitted",
        "confirmation_number": conf_match.group(0) if conf_match else None,
        "from": "SoFi Checking",
        "to": to_account,
        "amount": amount,
    }


# ── Helpers ─────────────────────────────────────────────────────────────────


def _safe_count(locator) -> int:
    try:
        return locator.count()
    except Exception:
        return 0


def _safe_text(locator) -> str:
    try:
        return locator.text_content() or ""
    except Exception:
        return ""


def _extract_merchant(text: str) -> str:
    merchant = re.sub(r"\d{1,2}/\d{1,2}(/\d{2,4})?", "", text)
    merchant = re.sub(r"[A-Z][a-z]+\s+\d{1,2},?\s*\d{0,4}", "", merchant)
    merchant = re.sub(r"-?\$[\d,]+\.?\d*", "", merchant)
    merchant = re.sub(r"pending", "", merchant, flags=re.I)
    merchant = re.sub(r"\s+", " ", merchant).strip()
    return merchant
