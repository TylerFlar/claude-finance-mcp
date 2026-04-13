#!/usr/bin/env node
/**
 * Opens a VISIBLE browser with a persistent profile for manual bank login.
 * Log in yourself, complete 2FA, then the script detects success and saves the session.
 *
 * Uses a persistent context (real browser profile on disk) which avoids
 * bot-detection flags from sites like Capital One. The profile persists
 * between runs, so remembered devices / cookies carry over.
 *
 * Usage:
 *   npx tsx src/scripts/manual-login.ts bofa
 *   npx tsx src/scripts/manual-login.ts capitalone
 *   npx tsx src/scripts/manual-login.ts sofi
 */

import { firefox, type BrowserContext, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BANKS: Record<string, { name: string; loginUrl: string; successIndicator: string }> = {
  sofi: {
    name: "SoFi",
    loginUrl: "https://www.sofi.com/login",
    successIndicator: "banking,dashboard,account,member-home",
  },
  bofa: {
    name: "Bank of America",
    loginUrl: "https://www.bankofamerica.com/",
    successIndicator: "accounts-overview,account-summary,myaccounts",
  },
  capitalone: {
    name: "Capital One",
    loginUrl: "https://verified.capitalone.com/auth/signin",
    successIndicator: "accountSummary,dashboard,accounts,myaccounts",
  },
};

const bankArg = process.argv[2]?.toLowerCase();
if (!bankArg || !BANKS[bankArg]) {
  console.error(`Usage: npx tsx src/scripts/manual-login.ts <${Object.keys(BANKS).join("|")}>`);
  process.exit(1);
}

const bank = BANKS[bankArg];

// Session output (for Docker volume copy)
const browserDataDir = process.env.BROWSER_DATA_DIR || "./data/browser";
const sessionDir = path.join(browserDataDir, bankArg);
const sessionPath = path.join(sessionDir, "session.json");

// Persistent profile lives locally so it survives across runs
const profileDir = path.join(browserDataDir, `${bankArg}-profile`);

console.log(`\n=== ${bank.name} Manual Login ===`);
console.log(`A browser window will open. Log in manually and complete any 2FA.`);
console.log(`Session will be saved to: ${sessionPath}`);
console.log(`Browser profile: ${profileDir}\n`);

fs.mkdirSync(sessionDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

// Use Firefox to match the scraper in shared.ts (which uses firefox.launch).
// This ensures session cookies are compatible between login and scraping.
console.log("Using Playwright Firefox (matches finance MCP scraper).");

const context: BrowserContext = await firefox.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  args: ["--disable-webgl"],
});

const page: Page = context.pages()[0] || await context.newPage();
await page.goto(bank.loginUrl, { waitUntil: "domcontentloaded" });

console.log("\nWaiting for you to log in...");
console.log("(Watching for successful login URL — or close the browser to abort)\n");

const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const start = Date.now();
let success = false;

while (Date.now() - start < TIMEOUT_MS) {
  try {
    if (context.pages().length === 0) {
      console.log("Browser closed. Aborting.");
      break;
    }

    const currentUrl = page.url();
    const indicators = bank.successIndicator.split(",");
    if (indicators.some(s => currentUrl.includes(s))) {
      console.log(`Detected successful login! URL: ${currentUrl}`);
      await page.waitForTimeout(3000);
      success = true;
      break;
    }
  } catch {
    // Page might be navigating
  }

  await new Promise(r => setTimeout(r, POLL_MS));
}

if (success) {
  const state = await context.storageState();
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  console.log(`\nSession saved to ${sessionPath}`);
  console.log("You can close the browser now.");
} else if (Date.now() - start >= TIMEOUT_MS) {
  console.log("Timed out waiting for login.");
}

// Wait for user to close browser
try {
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
    setTimeout(() => resolve(), 120000);
  });
} catch {
  // already closed
}

await context.close().catch(() => {});
console.log("Done.");
