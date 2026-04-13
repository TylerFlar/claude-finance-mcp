"""Manual login script — opens a visible browser for bank login.

Usage: uv run python scripts/manual_login.py <bofa|sofi|capitalone>

If credentials env vars are set, auto-fills username/password and handles TOTP.
Otherwise opens the login page for manual login.
Session persists automatically via Camoufox persistent profile.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Add parent dir to path so we can import banks/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from camoufox.sync_api import Camoufox

from banks.shared import get_bank_config


@dataclass
class BankDef:
    name: str
    login_url: str
    username_env: str
    password_env: str
    totp_env: str | None
    username_selector: str
    password_selector: str
    submit_selector: str
    success_indicators: list[str]


BANKS: dict[str, BankDef] = {
    "sofi": BankDef(
        name="SoFi",
        login_url="https://www.sofi.com/login",
        username_env="SOFI_USERNAME",
        password_env="SOFI_PASSWORD",
        totp_env="SOFI_TOTP_SECRET",
        username_selector="input[name='email'], input[type='email'], #email",
        password_selector="input[name='password'], input[type='password'], #password",
        submit_selector=(
            "button[type='submit'], button:has-text('Log in'), button:has-text('Sign in')"
        ),
        success_indicators=["banking", "dashboard", "account", "wealth", "mysofi"],
    ),
    "bofa": BankDef(
        name="Bank of America",
        login_url="https://www.bankofamerica.com/",
        username_env="BOFA_USERNAME",
        password_env="BOFA_PASSWORD",
        totp_env=None,
        username_selector="input#oid",
        password_selector="input#pass",
        submit_selector="button#secure-signin-submit",
        success_indicators=["accounts-overview", "account-summary", "myaccounts"],
    ),
    "capitalone": BankDef(
        name="Capital One",
        login_url="https://verified.capitalone.com/auth/signin",
        username_env="CAPITALONE_USERNAME",
        password_env="CAPITALONE_PASSWORD",
        totp_env=None,
        username_selector="input#userId, input[name='userId'], input[type='text']",
        password_selector="input#password, input[name='password'], input[type='password']",
        submit_selector="button[type='submit'], button:has-text('Sign In')",
        success_indicators=["accountSummary", "dashboard", "accounts"],
    ),
}


def _is_logged_in(url: str, bank: BankDef) -> bool:
    # Positive: URL contains a known post-login indicator
    if any(s in url for s in bank.success_indicators):
        return True
    # Negative: no longer on login/signin page (and not a blank/about page)
    if url and "login" not in url and "signin" not in url and "auth" not in url:
        if url.startswith("http") and url != bank.login_url:
            return True
    return False


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1].lower() not in BANKS:
        print(f"Usage: uv run python scripts/manual_login.py <{'|'.join(BANKS)}>")
        sys.exit(1)

    bank_key = sys.argv[1].lower()
    bank = BANKS[bank_key]
    config = get_bank_config()

    profile_dir = os.path.join(config.browser_data_dir, bank_key)
    os.makedirs(profile_dir, exist_ok=True)

    username = os.environ.get(bank.username_env)
    password = os.environ.get(bank.password_env)
    totp_secret = os.environ.get(bank.totp_env) if bank.totp_env else None

    print(f"=== {bank.name} Login Setup ===")
    print(f"Profile dir: {profile_dir}")
    print(f"Credentials: {'auto-fill' if username and password else 'manual'}")

    with Camoufox(
        headless=False,
        persistent_context=True,
        user_data_dir=profile_dir,
        humanize=True,
    ) as context:
        page = context.pages[0] if context.pages else context.new_page()

        print(f"\nNavigating to {bank.login_url}...")
        page.goto(bank.login_url, wait_until="domcontentloaded")
        page.wait_for_timeout(2000)

        if username and password:
            print("Entering credentials...")
            username_input = page.locator(bank.username_selector).first()
            username_input.fill(username)

            password_input = page.locator(bank.password_selector).first()
            password_input.fill(password)

            submit_btn = page.locator(bank.submit_selector).first()
            submit_btn.click()
            page.wait_for_timeout(3000)

            url = page.url
            if not _is_logged_in(url, bank):
                print("\n2FA may be required.")
                print(f"Current URL: {url}")

                # BofA: select SMS delivery
                bofa_text_radio = page.locator("#authcodeTextReceive")
                try:
                    if bofa_text_radio.is_visible(timeout=3000):
                        print("BofA: Selecting 'Text message' delivery...")
                        bofa_text_radio.check()
                        page.locator("#ah-authcode-select-continue-btn").click()
                        page.wait_for_timeout(3000)
                        print("Code sent! Check your phone.")
                except Exception:
                    pass

                if totp_secret:
                    import pyotp

                    code = pyotp.TOTP(totp_secret).now()
                    print(f"Generated TOTP code: {code}")

                    code_input = page.locator(
                        "input[name*='code'], input[name*='otp'], "
                        "input[type='tel'], input[placeholder*='code']"
                    ).first()
                    try:
                        if code_input.is_visible(timeout=5000):
                            code_input.fill(code)
                            submit_2fa = page.locator(
                                "button[type='submit'], button:has-text('Continue'), "
                                "button:has-text('Submit'), button:has-text('Verify')"
                            ).first()
                            submit_2fa.click()
                            page.wait_for_timeout(3000)
                    except Exception:
                        print("Could not auto-fill TOTP. Please enter it manually.")
                else:
                    code = input("Enter your 2FA code: ").strip()

                    # Try BofA-specific input first
                    code_input = page.locator("#ahAuthcodeValidateOTP")
                    try:
                        if not code_input.is_visible(timeout=3000):
                            raise Exception("not visible")
                    except Exception:
                        code_input = page.locator(
                            "input[name*='code'], input[name*='otp'], "
                            "input[name*='OTP'], input[type='tel'], "
                            "input[placeholder*='code']"
                        ).first()

                    try:
                        if code_input.is_visible(timeout=10000):
                            code_input.fill(code)

                            # Check "Remember this device" if available
                            remember = page.locator("#rememberDevice")
                            try:
                                if remember.is_visible(timeout=1000):
                                    remember.check()
                            except Exception:
                                pass

                            submit_2fa = page.locator(
                                "button[type='submit'], button:has-text('Continue'), "
                                "button:has-text('Submit'), button:has-text('Verify'), "
                                "button:has-text('Next'), #ah-authcode-validate-continue-btn"
                            ).first()
                            submit_2fa.click()
                            page.wait_for_timeout(5000)
                    except Exception:
                        print(f"Could not find code input. URL: {page.url}")
        else:
            print("\nNo credentials found. Please log in manually in the browser.")
            print("The script will wait for you to complete login...")

        # Poll for success — check URL and page title
        print("\nWaiting for login to complete...")
        print("(Will auto-detect when you reach the dashboard)")
        last_url = ""
        for _ in range(300):  # Wait up to 5 minutes
            current_url = page.url
            if current_url != last_url:
                print(f"  URL: {current_url}")
                last_url = current_url
            if _is_logged_in(current_url, bank):
                break
            # Also check if page title suggests logged in
            try:
                title = page.title().lower()
                if any(
                    kw in title
                    for kw in ["dashboard", "account", "summary", "home", "welcome"]
                ):
                    print(f"  Title indicates login: {page.title()}")
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            print("\nTimed out waiting. Saving session anyway.")

        final_url = page.url
        if _is_logged_in(final_url, bank):
            print(f"\n{bank.name} login successful! Session saved to profile.")
        else:
            print(f"\nLogin may not have completed. URL: {final_url}")
            print("Session saved anyway — you may need to re-run.")

        # Give a moment for cookies to flush
        page.wait_for_timeout(1000)


if __name__ == "__main__":
    main()
