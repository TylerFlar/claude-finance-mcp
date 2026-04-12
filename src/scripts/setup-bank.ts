import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

const DEFAULT_BROWSER_DIR = path.join(os.homedir(), ".config", "claude-finance-mcp");

interface BankDef {
  name: string;
  loginUrl: string;
  usernameEnv: string;
  passwordEnv: string;
  totpEnv: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successIndicator: string;
}

const BANKS: Record<string, BankDef> = {
  sofi: {
    name: "SoFi",
    loginUrl: "https://www.sofi.com/login",
    usernameEnv: "SOFI_USERNAME",
    passwordEnv: "SOFI_PASSWORD",
    totpEnv: "SOFI_TOTP_SECRET",
    usernameSelector: "input[name='email'], input[type='email'], #email",
    passwordSelector: "input[name='password'], input[type='password'], #password",
    submitSelector: "button[type='submit'], button:has-text('Log in'), button:has-text('Sign in')",
    successIndicator: "banking,dashboard,account",
  },
  bofa: {
    name: "Bank of America",
    loginUrl: "https://www.bankofamerica.com/",
    usernameEnv: "BOFA_USERNAME",
    passwordEnv: "BOFA_PASSWORD",
    totpEnv: "BOFA_TOTP_SECRET",
    usernameSelector: "input#onlineId1, input[name='onlineId']",
    passwordSelector: "input#passcode1, input[name='passcode']",
    submitSelector: "input#signIn, button#signIn, input[type='submit']",
    successIndicator: "accounts-overview,account-summary,myaccounts",
  },
  capitalone: {
    name: "Capital One",
    loginUrl: "https://verified.capitalone.com/auth/signin",
    usernameEnv: "CAPITALONE_USERNAME",
    passwordEnv: "CAPITALONE_PASSWORD",
    totpEnv: "CAPITALONE_TOTP_SECRET",
    usernameSelector: "input#userId, input[name='userId'], input[type='text']",
    passwordSelector: "input#password, input[name='password'], input[type='password']",
    submitSelector: "button[type='submit'], button:has-text('Sign In')",
    successIndicator: "accountSummary,dashboard,accounts",
  },
};

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const bankArg = process.argv[2]?.toLowerCase();
  if (!bankArg || !BANKS[bankArg]) {
    console.error(`Usage: node setup-bank.js <bank>`);
    console.error(`Available banks: ${Object.keys(BANKS).join(", ")}`);
    process.exit(1);
  }

  const bank = BANKS[bankArg];
  const browserDataDir = process.env.BROWSER_DATA_DIR || DEFAULT_BROWSER_DIR;
  const sessionDir = path.join(browserDataDir, bankArg);
  const sessionPath = path.join(sessionDir, "session.json");
  const headless = process.env.HEADLESS !== "false";

  const username = process.env[bank.usernameEnv];
  const password = process.env[bank.passwordEnv];
  const totpSecret = process.env[bank.totpEnv];

  if (!username || !password) {
    console.error(`Error: ${bank.usernameEnv} and ${bank.passwordEnv} must be set.`);
    process.exit(1);
  }

  console.log(`=== ${bank.name} Login Setup ===`);
  console.log(`Headless: ${headless}`);
  console.log(`Session dir: ${sessionDir}`);

  fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await chromium.launch({
    headless,
    args: ["--disable-webgl", "--disable-software-rasterizer", "--no-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  console.log(`\nNavigating to ${bank.loginUrl}...`);
  await page.goto(bank.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Fill credentials
  console.log("Entering credentials...");
  const usernameInput = page.locator(bank.usernameSelector).first();
  await usernameInput.fill(username);

  const passwordInput = page.locator(bank.passwordSelector).first();
  await passwordInput.fill(password);

  const submitBtn = page.locator(bank.submitSelector).first();
  await submitBtn.click();
  await page.waitForTimeout(3000);

  // Check for 2FA
  const url = page.url();
  const isLoggedIn = bank.successIndicator.split(",").some(s => url.includes(s));

  if (!isLoggedIn) {
    console.log("\n2FA may be required.");

    if (totpSecret) {
      console.log("Generating TOTP code...");
      const { TOTP, Secret } = await import("otpauth");
      const totp = new TOTP({ secret: Secret.fromBase32(totpSecret) });
      const code = totp.generate();
      console.log(`TOTP code: ${code}`);

      // Try to find and fill 2FA input
      const codeInput = page.locator("input[name*='code'], input[name*='otp'], input[type='tel'], input[placeholder*='code']").first();
      if (await codeInput.isVisible({ timeout: 5000 })) {
        await codeInput.fill(code);
        const submit2FA = page.locator("button[type='submit'], button:has-text('Continue'), button:has-text('Submit'), button:has-text('Verify')").first();
        await submit2FA.click();
        await page.waitForTimeout(3000);
      }
    } else {
      const code = await ask("Enter your 2FA code: ");
      const codeInput = page.locator("input[name*='code'], input[name*='otp'], input[type='tel'], input[placeholder*='code']").first();
      if (await codeInput.isVisible({ timeout: 5000 })) {
        await codeInput.fill(code);
        const submit2FA = page.locator("button[type='submit'], button:has-text('Continue'), button:has-text('Submit'), button:has-text('Verify')").first();
        await submit2FA.click();
        await page.waitForTimeout(3000);
      }
    }
  }

  // Save session
  console.log("\nSaving session...");
  const state = await context.storageState();
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));

  const finalUrl = page.url();
  const loggedIn = bank.successIndicator.split(",").some(s => finalUrl.includes(s));

  await page.close();
  await context.close();
  await browser.close();

  if (loggedIn) {
    console.log(`\n${bank.name} login successful! Session saved.`);
  } else {
    console.log(`\nLogin may not have completed. Current URL: ${finalUrl}`);
    console.log("Session saved anyway — you may need to re-run if it didn't work.");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
