from __future__ import annotations

import re
from datetime import datetime, timedelta

from playwright.sync_api import Page

from .shared import (
    BankSessionExpiredError,
    parse_dollar_amount,
    parse_transaction_date,
    wait_for_navigation,
)

BOFA_OVERVIEW_URL = (
    "https://secure.bankofamerica.com/myaccounts/brain/redirect.go"
    "?source=overview&target=accountsoverview"
)
BOFA_TRANSFER_URL = (
    "https://secure.bankofamerica.com/myaccounts/brain/redirect.go"
    "?source=overview&target=transfer"
)
BOFA_BILLPAY_URL = (
    "https://secure.bankofamerica.com/myaccounts/brain/redirect.go"
    "?source=overview&target=billpay"
)


def _check_bofa_logged_in(page: Page) -> None:
    url = page.url
    if "signin" in url or "login" in url or "bankofamerica.com" not in url:
        raise BankSessionExpiredError("bofa")


# ── Balances ────────────────────────────────────────────────────────────────


def scrape_balances(page: Page) -> list[dict]:
    page.goto(BOFA_OVERVIEW_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    _check_bofa_logged_in(page)

    balances: list[dict] = []

    # Bank Accounts section
    bank_section = page.locator(
        "[id*='bankAccounts'], [class*='bank-accounts'], "
        ":has-text('Bank Accounts') >> xpath=.."
    ).first()
    bank_rows = bank_section.locator(
        "[class*='AccountItem'], [class*='account-row'], li, tr"
    )
    bank_count = _safe_count(bank_rows)

    for i in range(bank_count):
        row = bank_rows.nth(i)
        text = _safe_text(row)
        if not re.search(r"checking|savings", text, re.I):
            continue

        amount_match = re.search(r"\$[\d,]+\.?\d*", text)
        amount = parse_dollar_amount(amount_match.group(0)) if amount_match else None
        is_checking = bool(re.search(r"checking", text, re.I))

        balances.append({
            "institution": "Bank of America",
            "account_name": "BofA Checking" if is_checking else "BofA Savings",
            "type": "checking",
            "current_balance": amount or 0,
            "available_balance": amount,
            "currency": "USD",
        })

    # Credit Cards section
    credit_section = page.locator(
        "[id*='creditCard'], [class*='credit-card'], "
        ":has-text('Credit Cards') >> xpath=.."
    ).first()
    credit_rows = credit_section.locator(
        "[class*='AccountItem'], [class*='account-row'], li, tr"
    )
    credit_count = _safe_count(credit_rows)

    for i in range(credit_count):
        row = credit_rows.nth(i)
        text = _safe_text(row)
        amount_match = re.search(r"\$[\d,]+\.?\d*", text)
        amount = parse_dollar_amount(amount_match.group(0)) if amount_match else None

        name_match = re.match(r"^([A-Za-z\s]+?)(?:\d|\.|\$)", text)
        card_name = name_match.group(1).strip() if name_match else "BofA Credit Card"

        balances.append({
            "institution": "Bank of America",
            "account_name": card_name or "BofA Credit Card",
            "type": "credit",
            "current_balance": amount or 0,
            "available_balance": None,
            "currency": "USD",
        })

    # Fallback: scan full page
    if not balances:
        body_text = _safe_text(
            page.locator("main, #main-content, body").first()
        )
        checking_match = re.search(
            r"[Cc]hecking[\s\S]{0,100}?(\$[\d,]+\.\d{2})", body_text
        )
        if checking_match:
            balances.append({
                "institution": "Bank of America",
                "account_name": "BofA Checking",
                "type": "checking",
                "current_balance": parse_dollar_amount(checking_match.group(1)) or 0,
                "available_balance": parse_dollar_amount(checking_match.group(1)),
                "currency": "USD",
            })
        credit_match = re.search(
            r"[Cc]redit\s*[Cc]ard[\s\S]{0,100}?(\$[\d,]+\.\d{2})", body_text
        )
        if credit_match:
            balances.append({
                "institution": "Bank of America",
                "account_name": "BofA Credit Card",
                "type": "credit",
                "current_balance": parse_dollar_amount(credit_match.group(1)) or 0,
                "available_balance": None,
                "currency": "USD",
            })

    return balances


# ── Transactions ────────────────────────────────────────────────────────────


def scrape_transactions(page: Page, days_back: int) -> list[dict]:
    page.goto(BOFA_OVERVIEW_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    _check_bofa_logged_in(page)

    transactions: list[dict] = []
    cutoff = datetime.now() - timedelta(days=days_back)

    # Click into checking account
    checking_link = page.locator(
        "a:has-text('Checking'), a[class*='account-name']:has-text('Checking')"
    ).first()
    try:
        if checking_link.is_visible(timeout=5000):
            checking_link.click()
            wait_for_navigation(page)
            _scrape_transaction_rows(page, transactions, "BofA Checking", cutoff)
            page.go_back()
            wait_for_navigation(page)
    except Exception:
        pass

    # Click into credit card account
    credit_link = page.locator(
        "a:has-text('Credit Card'), a:has-text('Cash Rewards'), "
        "a[class*='account-name']:has-text('Credit')"
    ).first()
    try:
        if credit_link.is_visible(timeout=5000):
            credit_link.click()
            wait_for_navigation(page)
            _scrape_transaction_rows(page, transactions, "BofA Credit Card", cutoff)
    except Exception:
        pass

    return transactions


def _scrape_transaction_rows(
    page: Page, out: list[dict], account_name: str, cutoff: datetime
) -> None:
    rows = page.locator(
        "[data-testid*='transaction'], .transaction-row, "
        "[class*='TransactionRow'], tr.transaction, [class*='activity-row']"
    )
    count = _safe_count(rows)

    for i in range(count):
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
            out.append({
                "date": date_str or datetime.now().strftime("%Y-%m-%d"),
                "merchant": merchant,
                "amount": abs(amount),
                "category": "Uncategorized",
                "account_name": account_name,
                "pending": bool(re.search(r"pending", text, re.I)),
            })


# ── Credit Due Date ─────────────────────────────────────────────────────────


def scrape_credit_due(page: Page) -> dict | None:
    page.goto(BOFA_OVERVIEW_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    _check_bofa_logged_in(page)

    # Click into credit card
    credit_link = page.locator(
        "a:has-text('Credit Card'), a:has-text('Cash Rewards'), "
        "a[class*='account-name']:has-text('Credit')"
    ).first()
    try:
        if not credit_link.is_visible(timeout=5000):
            return None
    except Exception:
        return None

    credit_link.click()
    wait_for_navigation(page)

    body_text = _safe_text(page.locator("main, #main-content, body").first())

    due_date_match = re.search(
        r"[Pp]ayment\s*[Dd]ue\s*[Dd]ate[\s:]*"
        r"([A-Za-z]+\s+\d{1,2},?\s*\d{4}|\d{1,2}/\d{1,2}/\d{4})",
        body_text,
    )
    due_date = parse_transaction_date(due_date_match.group(1)) if due_date_match else None

    stmt_match = re.search(
        r"[Ss]tatement\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)", body_text
    )
    statement_balance = parse_dollar_amount("$" + stmt_match.group(1)) if stmt_match else None

    min_match = re.search(
        r"[Mm]inimum\s*[Pp]ayment[\s:]*\$?([\d,]+\.?\d*)", body_text
    )
    minimum_payment = parse_dollar_amount("$" + min_match.group(1)) if min_match else None

    return {
        "institution": "Bank of America",
        "account_name": "BofA Credit Card",
        "statement_balance": statement_balance,
        "minimum_payment": minimum_payment,
        "due_date": due_date,
    }


# ── Transfer ────────────────────────────────────────────────────────────────


def transfer(page: Page, from_account: str, to_account: str, amount: float) -> dict:
    page.goto(BOFA_TRANSFER_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    _check_bofa_logged_in(page)

    # Select from account
    from_select = page.locator(
        "select[id*='from'], select[name*='from']"
    ).first()
    from_options = from_select.locator("option").all_text_contents()
    from_match = next(
        (o for o in from_options if re.search(from_account, o, re.I)), None
    )
    if from_match:
        from_select.select_option(label=from_match)

    # Select to account
    to_select = page.locator(
        "select[id*='to'], select[name*='to']"
    ).first()
    to_options = to_select.locator("option").all_text_contents()
    to_match = next(
        (o for o in to_options if re.search(to_account, o, re.I)), None
    )
    if to_match:
        to_select.select_option(label=to_match)

    # Enter amount
    amount_input = page.locator(
        "input[id*='amount'], input[name*='amount']"
    ).first()
    amount_input.fill(f"{amount:.2f}")

    # Submit
    submit_btn = page.locator(
        "button:has-text('Review'), button:has-text('Next'), input[type='submit']"
    ).first()
    submit_btn.click()
    wait_for_navigation(page)

    # Confirm
    confirm_btn = page.locator(
        "button:has-text('Submit'), button:has-text('Confirm'), input[value*='ubmit']"
    ).first()
    try:
        if confirm_btn.is_visible(timeout=5000):
            confirm_btn.click()
            wait_for_navigation(page)
    except Exception:
        pass

    confirm_text = _safe_text(
        page.locator(".confirmation-number, [class*='confirm']").first()
    )
    conf_match = re.search(r"\b[A-Z0-9]{6,}\b", confirm_text)

    return {
        "status": "submitted",
        "confirmation_number": conf_match.group(0) if conf_match else None,
        "from": from_account,
        "to": to_account,
        "amount": amount,
    }


# ── Pay Credit Card ─────────────────────────────────────────────────────────


def pay_credit_card(page: Page, amount: str | float, from_account: str) -> dict:
    page.goto(BOFA_BILLPAY_URL, wait_until="domcontentloaded")
    wait_for_navigation(page)
    _check_bofa_logged_in(page)

    # Select payment source
    from_select = page.locator(
        "select[id*='from'], select[name*='from']"
    ).first()
    if from_select.is_visible():
        pay_options = from_select.locator("option").all_text_contents()
        pay_match = next(
            (o for o in pay_options if re.search(from_account, o, re.I)), None
        )
        if pay_match:
            from_select.select_option(label=pay_match)

    # Select amount type
    if amount == "statement":
        page.locator(
            "input[value*='statement'], label:has-text('Statement balance')"
        ).first().click()
    elif amount == "minimum":
        page.locator(
            "input[value*='minimum'], label:has-text('Minimum')"
        ).first().click()
    else:
        page.locator(
            "input[value*='other'], label:has-text('Other amount')"
        ).first().click()
        amt = float(amount)
        page.locator(
            "input[id*='amount'], input[name*='amount']"
        ).first().fill(f"{amt:.2f}")

    # Submit
    submit_btn = page.locator(
        "button:has-text('Review'), button:has-text('Next'), input[type='submit']"
    ).first()
    submit_btn.click()
    wait_for_navigation(page)

    # Read actual amount from confirmation page
    amount_text = _safe_text(
        page.locator("[class*='amount'], .payment-amount").first()
    )
    paid_amount = _parse_paid_amount(amount_text, amount)

    # Confirm
    confirm_btn = page.locator(
        "button:has-text('Submit'), button:has-text('Confirm'), input[value*='ubmit']"
    ).first()
    try:
        if confirm_btn.is_visible(timeout=5000):
            confirm_btn.click()
            wait_for_navigation(page)
    except Exception:
        pass

    confirm_text = _safe_text(
        page.locator(".confirmation-number, [class*='confirm']").first()
    )
    conf_match = re.search(r"\b[A-Z0-9]{6,}\b", confirm_text)

    return {
        "status": "submitted",
        "confirmation_number": conf_match.group(0) if conf_match else None,
        "amount_paid": paid_amount,
        "from": from_account,
        "card": "BofA Credit Card",
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


def _parse_paid_amount(text: str, original_amount: str | float) -> float:
    try:
        return float(re.sub(r"[$,]", "", text))
    except (ValueError, TypeError):
        if isinstance(original_amount, (int, float)):
            return float(original_amount)
        return 0.0
