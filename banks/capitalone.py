from __future__ import annotations

import re
from datetime import datetime, timedelta

from playwright.async_api import Page

from .shared import (
    check_logged_in,
    parse_dollar_amount,
    parse_transaction_date,
    wait_for_navigation,
)

CAPITALONE_URL = "https://myaccounts.capitalone.com/accountSummary"


# ── Balances ────────────────────────────────────────────────────────────────


async def scrape_balances(page: Page) -> list[dict]:
    await page.goto(CAPITALONE_URL, wait_until="domcontentloaded")
    await wait_for_navigation(page)
    await check_logged_in(page, "capitalone")

    balances: list[dict] = []

    account_cards = page.locator(
        "[data-testid*='account'], [class*='AccountCard'], "
        "[class*='account-tile'], [class*='account-summary']"
    )
    count = await _safe_count(account_cards)

    for i in range(count):
        card = account_cards.nth(i)
        text = await _safe_text(card)

        balance_match = re.search(
            r"[Cc]urrent\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)", text
        )
        current_balance = (
            parse_dollar_amount("$" + balance_match.group(1))
            if balance_match
            else None
        )

        avail_match = re.search(
            r"[Aa]vailable\s*[Cc]redit[\s:]*\$?([\d,]+\.?\d*)", text
        )
        available_credit = (
            parse_dollar_amount("$" + avail_match.group(1))
            if avail_match
            else None
        )

        name_match = re.match(r"([\w\s]+?)(?:Current|Available|\$|\d)", text)
        card_name = (
            name_match.group(1).strip()
            if name_match
            else "Capital One Credit Card"
        )

        if current_balance is not None or available_credit is not None:
            balances.append({
                "institution": "Capital One",
                "account_name": card_name or "Capital One Credit Card",
                "type": "credit",
                "current_balance": current_balance or 0,
                "available_balance": available_credit,
                "currency": "USD",
            })

    # Fallback: scan page text
    if not balances:
        body_text = await _safe_text(
            page.locator("main, [role='main'], body").first
        )
        balance_match = re.search(
            r"[Bb]alance[\s:]*\$?([\d,]+\.\d{2})", body_text
        )
        if balance_match:
            balances.append({
                "institution": "Capital One",
                "account_name": "Capital One Credit Card",
                "type": "credit",
                "current_balance": (
                    parse_dollar_amount("$" + balance_match.group(1)) or 0
                ),
                "available_balance": None,
                "currency": "USD",
            })

    return balances


# ── Transactions ────────────────────────────────────────────────────────────


async def scrape_transactions(page: Page, days_back: int) -> list[dict]:
    await page.goto(CAPITALONE_URL, wait_until="domcontentloaded")
    await wait_for_navigation(page)
    await check_logged_in(page, "capitalone")

    # Click into credit card account
    card_link = page.locator(
        "a[href*='credit'], [data-testid*='credit-card'], a[class*='account']"
    ).first
    try:
        if await card_link.is_visible(timeout=5000):
            await card_link.click()
            await wait_for_navigation(page)
    except Exception:
        pass

    # Look for activity tab
    activity_tab = page.locator(
        "a:has-text('Activity'), button:has-text('Activity'), "
        "a:has-text('Transactions'), [data-testid*='activity']"
    ).first
    try:
        if await activity_tab.is_visible(timeout=3000):
            await activity_tab.click()
            await wait_for_navigation(page)
    except Exception:
        pass

    transactions: list[dict] = []
    cutoff = datetime.now() - timedelta(days=days_back)

    rows = page.locator(
        "[data-testid*='transaction'], .transaction-row, "
        "[class*='TransactionRow'], [class*='activity-row'], "
        "tr[class*='transaction']"
    )
    row_count = await _safe_count(rows)

    for i in range(row_count):
        row = rows.nth(i)
        text = await _safe_text(row)

        date_str = parse_transaction_date(text)
        if date_str:
            try:
                tx_date = datetime.strptime(date_str, "%Y-%m-%d")
                if tx_date < cutoff:
                    continue
            except ValueError:
                pass

        amount_match = re.search(r"-?\$[\d,]+\.?\d*", text)
        amount = (
            parse_dollar_amount(amount_match.group(0)) if amount_match else None
        )

        # Capital One sometimes shows category
        category = "Uncategorized"
        cat_match = re.search(
            r"(?:Category|Type)[\s:]*([A-Za-z\s&]+?)(?:\$|\d|$)", text, re.I
        )
        if cat_match:
            category = cat_match.group(1).strip()

        merchant = _extract_merchant(text)

        if amount is not None and merchant:
            transactions.append({
                "date": date_str or datetime.now().strftime("%Y-%m-%d"),
                "merchant": merchant,
                "amount": abs(amount),
                "category": category,
                "account_name": "Capital One Credit Card",
                "pending": bool(re.search(r"pending", text, re.I)),
            })

    return transactions


# ── Credit Due Date ─────────────────────────────────────────────────────────


async def scrape_credit_due(page: Page) -> dict | None:
    await page.goto(CAPITALONE_URL, wait_until="domcontentloaded")
    await wait_for_navigation(page)
    await check_logged_in(page, "capitalone")

    # Click into credit card
    card_link = page.locator(
        "a[href*='credit'], [data-testid*='credit-card'], a[class*='account']"
    ).first
    try:
        if await card_link.is_visible(timeout=5000):
            await card_link.click()
            await wait_for_navigation(page)
    except Exception:
        pass

    body_text = await _safe_text(
        page.locator("main, [role='main'], body").first
    )

    due_date_match = re.search(
        r"[Pp]ayment\s*[Dd]ue[\s:]*"
        r"([A-Za-z]+\s+\d{1,2},?\s*\d{4}|\d{1,2}/\d{1,2}/\d{4})",
        body_text,
    )
    due_date = (
        parse_transaction_date(due_date_match.group(1))
        if due_date_match
        else None
    )

    stmt_match = re.search(
        r"[Ss]tatement\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)", body_text
    )
    statement_balance = (
        parse_dollar_amount("$" + stmt_match.group(1)) if stmt_match else None
    )

    min_match = re.search(
        r"[Mm]inimum\s*[Pp]ayment[\s:]*\$?([\d,]+\.?\d*)", body_text
    )
    minimum_payment = (
        parse_dollar_amount("$" + min_match.group(1)) if min_match else None
    )

    if not due_date and statement_balance is None and minimum_payment is None:
        return None

    return {
        "institution": "Capital One",
        "account_name": "Capital One Credit Card",
        "statement_balance": statement_balance,
        "minimum_payment": minimum_payment,
        "due_date": due_date,
    }


# ── Pay ─────────────────────────────────────────────────────────────────────


async def pay(page: Page, amount: str | float, from_bank: str) -> dict:
    await page.goto(CAPITALONE_URL, wait_until="domcontentloaded")
    await wait_for_navigation(page)
    await check_logged_in(page, "capitalone")

    # Navigate to credit card
    card_link = page.locator(
        "a[href*='credit'], [data-testid*='credit-card']"
    ).first
    await card_link.click(timeout=10000)
    await wait_for_navigation(page)

    # Click Make Payment
    pay_btn = page.locator(
        "button:has-text('Make a Payment'), "
        "a:has-text('Make a Payment'), "
        "button:has-text('Pay')"
    ).first
    await pay_btn.click(timeout=10000)
    await wait_for_navigation(page)

    # Select payment source if visible
    from_select = page.locator(
        "select[id*='from'], select[name*='bank'], "
        "[data-testid*='payment-source']"
    ).first
    try:
        if await from_select.is_visible(timeout=3000):
            from_options = (
                await from_select.locator("option").all_text_contents()
            )
            from_match = next(
                (o for o in from_options if re.search(from_bank, o, re.I)),
                None,
            )
            if from_match:
                await from_select.select_option(label=from_match)
    except Exception:
        pass

    # Select amount type
    if amount == "statement":
        await page.locator(
            "input[value*='statement'], label:has-text('Statement'), "
            "button:has-text('Statement')"
        ).first.click()
    elif amount == "minimum":
        await page.locator(
            "input[value*='minimum'], label:has-text('Minimum'), "
            "button:has-text('Minimum')"
        ).first.click()
    else:
        await page.locator(
            "input[value*='other'], label:has-text('Other'), "
            "button:has-text('Other')"
        ).first.click()
        amt = float(amount)
        await page.locator(
            "input[id*='amount'], input[name*='amount'], "
            "input[type='number']"
        ).first.fill(f"{amt:.2f}")

    # Submit / Review
    submit_btn = page.locator(
        "button:has-text('Review'), button:has-text('Continue'), "
        "button[type='submit']"
    ).first
    await submit_btn.click()
    await wait_for_navigation(page)

    # Read actual amount
    amount_text = await _safe_text(
        page.locator("[class*='amount'], [data-testid*='amount']").first
    )
    paid_amount = _parse_paid_amount(amount_text, amount)

    # Confirm
    confirm_btn = page.locator(
        "button:has-text('Submit'), button:has-text('Confirm')"
    ).first
    try:
        if await confirm_btn.is_visible(timeout=5000):
            await confirm_btn.click()
            await wait_for_navigation(page)
    except Exception:
        pass

    confirm_text = await _safe_text(
        page.locator("[class*='confirm'], [data-testid*='confirm']").first
    )
    conf_match = re.search(r"\b[A-Z0-9]{6,}\b", confirm_text)

    return {
        "status": "submitted",
        "confirmation_number": conf_match.group(0) if conf_match else None,
        "amount_paid": paid_amount,
    }


# ── Helpers ─────────────────────────────────────────────────────────────────


async def _safe_count(locator) -> int:
    try:
        return await locator.count()
    except Exception:
        return 0


async def _safe_text(locator) -> str:
    try:
        return await locator.text_content() or ""
    except Exception:
        return ""


def _extract_merchant(text: str) -> str:
    merchant = re.sub(r"\d{1,2}/\d{1,2}(/\d{2,4})?", "", text)
    merchant = re.sub(r"[A-Z][a-z]+\s+\d{1,2},?\s*\d{0,4}", "", merchant)
    merchant = re.sub(r"-?\$[\d,]+\.?\d*", "", merchant)
    merchant = re.sub(r"pending", "", merchant, flags=re.I)
    merchant = re.sub(r"\s+", " ", merchant).strip()
    return merchant


def _parse_paid_amount(text: str, original_amount: str | float) -> float:
    try:
        return float(re.sub(r"[$,]", "", text))
    except (ValueError, TypeError):
        if isinstance(original_amount, (int, float)):
            return float(original_amount)
        return 0.0
