from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from camoufox.async_api import AsyncCamoufox
from playwright.async_api import BrowserContext, Page

# ── Config ───────────────────────────────────────────────────────────────────

PROJECT_DIR = Path(__file__).resolve().parent.parent


@dataclass
class BankConfig:
    headless: bool
    browser_data_dir: str
    timeout: int  # milliseconds


def get_bank_config() -> BankConfig:
    return BankConfig(
        headless=os.environ.get("HEADLESS", "true").lower() != "false",
        browser_data_dir=os.environ.get(
            "BROWSER_DATA_DIR", str(PROJECT_DIR / "data" / "browser")
        ),
        timeout=int(os.environ.get("BANK_TIMEOUT", "30000")),
    )


# ── Errors ───────────────────────────────────────────────────────────────────


class BankSessionExpiredError(Exception):
    def __init__(self, bank: str) -> None:
        self.bank = bank
        super().__init__(
            f"{bank} session expired. Run: "
            f"uv run python scripts/manual_login.py {bank}"
        )


# ── Bank credential definitions ─────────────────────────────────────────────


@dataclass
class _BankCreds:
    username_env: str
    password_env: str
    totp_env: str | None
    login_url: str
    username_selector: str
    password_selector: str
    submit_selector: str
    success_indicators: list[str]


_BANK_CREDS: dict[str, _BankCreds] = {
    "sofi": _BankCreds(
        username_env="SOFI_USERNAME",
        password_env="SOFI_PASSWORD",
        totp_env="SOFI_TOTP_SECRET",
        login_url="https://www.sofi.com/login",
        username_selector=(
            "input[name='email'], input[type='email'], #email"
        ),
        password_selector=(
            "input[name='password'], input[type='password'], #password"
        ),
        submit_selector=(
            "button[type='submit'], button:has-text('Log in'), "
            "button:has-text('Sign in')"
        ),
        success_indicators=[
            "banking", "dashboard", "account", "wealth", "mysofi",
        ],
    ),
    "bofa": _BankCreds(
        username_env="BOFA_USERNAME",
        password_env="BOFA_PASSWORD",
        totp_env=None,
        login_url="https://www.bankofamerica.com/",
        username_selector="input#oid",
        password_selector="input#pass",
        submit_selector="button#secure-signin-submit",
        success_indicators=[
            "accounts-overview", "account-summary", "myaccounts",
        ],
    ),
    "capitalone": _BankCreds(
        username_env="CAPITALONE_USERNAME",
        password_env="CAPITALONE_PASSWORD",
        totp_env=None,
        login_url="https://verified.capitalone.com/auth/signin",
        username_selector=(
            "input#userId, input[name='userId'], input[type='text']"
        ),
        password_selector=(
            "input#password, input[name='password'], "
            "input[type='password']"
        ),
        submit_selector=(
            "button[type='submit'], button:has-text('Sign In')"
        ),
        success_indicators=["accountSummary", "dashboard", "accounts"],
    ),
}


# ── Session management ──────────────────────────────────────────────────────


@dataclass
class _BankSession:
    camoufox: Any  # AsyncCamoufox context manager
    context: BrowserContext
    page: Page


_sessions: dict[str, _BankSession] = {}


async def get_bank_page(bank: str) -> Page:
    """Get or create a persistent browser page for the given bank."""
    existing = _sessions.get(bank)
    if existing and not existing.page.is_closed():
        return existing.page

    config = get_bank_config()
    profile_dir = os.path.join(config.browser_data_dir, bank)
    os.makedirs(profile_dir, exist_ok=True)

    cm = AsyncCamoufox(
        headless=config.headless,
        persistent_context=True,
        user_data_dir=profile_dir,
        humanize=True,
    )
    context = await cm.__aenter__()
    page = context.pages[0] if context.pages else await context.new_page()
    page.set_default_timeout(config.timeout)

    _sessions[bank] = _BankSession(camoufox=cm, context=context, page=page)
    return page


async def cleanup_sessions() -> None:
    for _bank, session in list(_sessions.items()):
        try:
            await session.camoufox.__aexit__(None, None, None)
        except Exception:
            pass
    _sessions.clear()


# ── Auto-login ──────────────────────────────────────────────────────────────


async def _auto_login(page: Page, bank: str) -> bool:
    """Attempt to auto-login using env var credentials. Returns True on success."""
    creds = _BANK_CREDS.get(bank)
    if not creds:
        return False

    username = os.environ.get(creds.username_env)
    password = os.environ.get(creds.password_env)
    if not username or not password:
        return False

    _log(f"[{bank}] Session expired, attempting auto-login...")

    # Navigate to login page if not already there
    url = page.url
    if "login" not in url and "signin" not in url and "auth" not in url:
        await page.goto(creds.login_url, wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)

    # Fill credentials
    try:
        username_input = page.locator(creds.username_selector).first
        await username_input.fill(username)

        password_input = page.locator(creds.password_selector).first
        await password_input.fill(password)

        submit_btn = page.locator(creds.submit_selector).first
        await submit_btn.click()
        await page.wait_for_timeout(3000)
    except Exception as e:
        _log(f"[{bank}] Auto-login failed to fill credentials: {e}")
        return False

    # Handle TOTP for SoFi
    url = page.url
    if not _is_success(url, creds) and creds.totp_env:
        totp_secret = os.environ.get(creds.totp_env)
        if totp_secret:
            try:
                import pyotp

                code = pyotp.TOTP(totp_secret).now()
                _log(f"[{bank}] Entering TOTP code...")
                code_input = page.locator(
                    "input[name*='code'], input[name*='otp'], "
                    "input[type='tel'], input[placeholder*='code']"
                ).first
                if await code_input.is_visible(timeout=10000):
                    await code_input.fill(code)
                    submit_2fa = page.locator(
                        "button[type='submit'], "
                        "button:has-text('Continue'), "
                        "button:has-text('Verify')"
                    ).first
                    await submit_2fa.click()
                    await page.wait_for_timeout(5000)
            except Exception as e:
                _log(f"[{bank}] TOTP entry failed: {e}")

    # Check if login succeeded
    url = page.url
    if _is_success(url, creds):
        _log(f"[{bank}] Auto-login successful")
        return True

    # Also check title
    try:
        title = (await page.title()).lower()
        if any(
            kw in title
            for kw in ["dashboard", "account", "summary", "home"]
        ):
            _log(f"[{bank}] Auto-login successful (title match)")
            return True
    except Exception:
        pass

    _log(f"[{bank}] Auto-login may need 2FA. URL: {url}")
    return False


def _is_success(url: str, creds: _BankCreds) -> bool:
    return any(s in url for s in creds.success_indicators)


# ── Navigation helpers ──────────────────────────────────────────────────────


async def check_logged_in(page: Page, bank: str) -> None:
    """Check login status; attempt auto-login if expired."""
    url = page.url
    if "login" in url or "signin" in url:
        if not await _auto_login(page, bank):
            raise BankSessionExpiredError(bank)


async def wait_for_navigation(
    page: Page, timeout_ms: int = 30000
) -> None:
    """Wait for page to settle after navigation."""
    await page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    await page.wait_for_timeout(1000)


def _log(msg: str) -> None:
    """Log to stderr (stdout is MCP protocol)."""
    print(msg, file=sys.stderr)


# ── Parse helpers ───────────────────────────────────────────────────────────

_DOLLAR_RE = re.compile(r"-?\$?([\d,]+\.?\d*)")

_MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "may": "05", "jun": "06", "jul": "07", "aug": "08",
    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def parse_dollar_amount(text: str) -> float | None:
    m = _DOLLAR_RE.search(text)
    if not m:
        return None
    value = float(m.group(1).replace(",", ""))
    if value != value:  # NaN check
        return None
    return -value if "-" in text else value


def parse_transaction_date(text: str) -> str | None:
    now = datetime.now()

    # ISO: 2026-04-10
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    # MM/DD/YYYY
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if m:
        return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"

    # Mon DD, YYYY (e.g. "Apr 10, 2026")
    m = re.search(r"([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})?", text)
    if m:
        mon = _MONTHS.get(m.group(1).lower()[:3])
        if mon:
            year = m.group(3) or str(now.year)
            return f"{year}-{mon}-{m.group(2).zfill(2)}"

    # MM/DD (current year)
    m = re.match(r"^(\d{1,2})/(\d{1,2})$", text.strip())
    if m:
        return f"{now.year}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"

    return None
