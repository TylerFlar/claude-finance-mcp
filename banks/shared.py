from __future__ import annotations

import atexit
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from camoufox.sync_api import Camoufox
from playwright.sync_api import BrowserContext, Page

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
            f"{bank} session expired. Run: uv run python scripts/manual_login.py {bank}"
        )


# ── Session management ──────────────────────────────────────────────────────


@dataclass
class _BankSession:
    camoufox: Any  # Camoufox context manager
    context: BrowserContext
    page: Page


_sessions: dict[str, _BankSession] = {}


def get_bank_page(bank: str) -> Page:
    """Get or create a persistent browser page for the given bank."""
    existing = _sessions.get(bank)
    if existing and not existing.page.is_closed():
        return existing.page

    config = get_bank_config()
    profile_dir = os.path.join(config.browser_data_dir, bank)
    os.makedirs(profile_dir, exist_ok=True)

    cm = Camoufox(
        headless=config.headless,
        persistent_context=True,
        user_data_dir=profile_dir,
        humanize=True,
    )
    context = cm.__enter__()
    page = context.pages[0] if context.pages else context.new_page()
    page.set_default_timeout(config.timeout)

    _sessions[bank] = _BankSession(camoufox=cm, context=context, page=page)
    return page


def _cleanup_sessions() -> None:
    for bank, session in list(_sessions.items()):
        try:
            session.camoufox.__exit__(None, None, None)
        except Exception:
            pass
    _sessions.clear()


atexit.register(_cleanup_sessions)


# ── Navigation helpers ──────────────────────────────────────────────────────


def check_logged_in(page: Page, bank: str) -> None:
    """Raise BankSessionExpiredError if the page is on a login screen."""
    url = page.url()
    if "login" in url or "signin" in url:
        raise BankSessionExpiredError(bank)


def wait_for_navigation(page: Page, timeout_ms: int = 30000) -> None:
    """Wait for page to settle after navigation."""
    page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    page.wait_for_timeout(1000)


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
