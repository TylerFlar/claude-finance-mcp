"""Finance MCP server — browser automation tools for bank navigation.

Exposes generic browser tools (screenshot, click, type, navigate, etc.)
that let the calling LLM drive Camoufox to scrape bank data directly.
Auto-login handles credential entry when sessions expire.
"""

from __future__ import annotations

import base64

from mcp.server.fastmcp import FastMCP, Image

from banks import ALL_BANKS, BANK_HOME_URLS
from banks.shared import check_logged_in, get_bank_page, wait_for_navigation

mcp = FastMCP("finance")


# ── Browser tools ──────────────────────────────────────────────────────────


@mcp.tool()
async def bank_navigate(bank: str, url: str | None = None) -> str:
    """Navigate a bank's browser to a URL. Auto-logs in if session expired.

    bank: 'sofi', 'bofa', or 'capitalone'
    url: URL to navigate to (defaults to the bank's home/dashboard page)

    Returns the page text content after navigation.
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    target = url or BANK_HOME_URLS[bank]
    await page.goto(target, wait_until="domcontentloaded")
    await wait_for_navigation(page)
    await check_logged_in(page, bank)

    text = await page.locator("body").text_content() or ""
    return _truncate(text, 5000)


@mcp.tool()
async def bank_screenshot(bank: str) -> Image:
    """Take a screenshot of the bank's current browser page.

    bank: 'sofi', 'bofa', or 'capitalone'
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    data = await page.screenshot(type="png")
    return Image(data=base64.b64encode(data).decode(), format="png")


@mcp.tool()
async def bank_click(bank: str, x: int, y: int) -> str:
    """Click at (x, y) coordinates on the bank's browser page.

    bank: 'sofi', 'bofa', or 'capitalone'
    x, y: pixel coordinates to click

    Returns the page text content after clicking.
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    await page.mouse.click(x, y)
    await page.wait_for_timeout(2000)

    text = await page.locator("body").text_content() or ""
    return _truncate(text, 5000)


@mcp.tool()
async def bank_type(bank: str, text: str) -> str:
    """Type text into the currently focused element on the bank's page.

    bank: 'sofi', 'bofa', or 'capitalone'
    text: the text to type
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    await page.keyboard.type(text, delay=50)
    return "OK"


@mcp.tool()
async def bank_get_text(bank: str) -> str:
    """Get the visible text content of the bank's current page.

    bank: 'sofi', 'bofa', or 'capitalone'
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    text = await page.locator("body").text_content() or ""
    return _truncate(text, 10000)


@mcp.tool()
async def bank_scroll(bank: str, direction: str = "down") -> str:
    """Scroll the bank's browser page.

    bank: 'sofi', 'bofa', or 'capitalone'
    direction: 'up' or 'down' (default: 'down')
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    delta = 500 if direction == "down" else -500
    await page.mouse.wheel(0, delta)
    await page.wait_for_timeout(1000)
    return "OK"


@mcp.tool()
async def bank_url(bank: str) -> str:
    """Get the current URL of the bank's browser page.

    bank: 'sofi', 'bofa', or 'capitalone'
    """
    _validate_bank(bank)
    page = await get_bank_page(bank)
    return page.url


# ── Helpers ─────────────────────────────────────────────────────────────────


def _validate_bank(bank: str) -> None:
    if bank not in ALL_BANKS:
        raise ValueError(
            f"Unknown bank: {bank}. Choose from: {', '.join(ALL_BANKS)}"
        )


def _truncate(text: str, max_len: int) -> str:
    text = " ".join(text.split())  # collapse whitespace
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


if __name__ == "__main__":
    mcp.run(transport="stdio")
