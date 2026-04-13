import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BankConfig } from "../types.js";

export class BankSessionExpiredError extends Error {
  constructor(public bank: string) {
    super(`${bank} session expired. Run setup:bank ${bank} to re-login.`);
    this.name = "BankSessionExpiredError";
  }
}

export async function ensureLoggedIn(page: Page, bank: string): Promise<void> {
  const url = page.url();
  if (url.includes("login") || url.includes("signin")) {
    throw new BankSessionExpiredError(bank);
  }
}

export function parseDollarAmount(text: string): number | null {
  const match = text.match(/-?\$?([\d,]+\.?\d*)/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  if (isNaN(value)) return null;
  return text.includes("-") ? -value : value;
}

export function parseTransactionDate(text: string): string | null {
  const now = new Date();
  // Try ISO-ish: 2026-04-10
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Try MM/DD/YYYY
  m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  // Try Mon DD, YYYY (e.g. "Apr 10, 2026")
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  m = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})?/);
  if (m) {
    const mon = months[m[1].toLowerCase().slice(0, 3)];
    if (mon) {
      const year = m[3] || String(now.getFullYear());
      return `${year}-${mon}-${m[2].padStart(2, "0")}`;
    }
  }
  // Try MM/DD (current year)
  m = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${now.getFullYear()}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

const DEFAULT_BROWSER_DIR = path.join(os.homedir(), ".config", "claude-finance-mcp");

interface BankSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<string, BankSession>();

export function getBankConfig(): BankConfig {
  return {
    headless: process.env.HEADLESS !== "false",
    browserDataDir: process.env.BROWSER_DATA_DIR || DEFAULT_BROWSER_DIR,
    timeout: parseInt(process.env.BANK_TIMEOUT || "30000", 10),
  };
}

function getSessionDir(config: BankConfig, bank: string): string {
  return path.join(config.browserDataDir, bank);
}

function getSessionPath(config: BankConfig, bank: string): string {
  return path.join(getSessionDir(config, bank), "session.json");
}

export async function getBankPage(bank: string): Promise<Page> {
  const existing = sessions.get(bank);
  if (existing && !existing.page.isClosed()) {
    return existing.page;
  }

  const config = getBankConfig();
  const sessionDir = getSessionDir(config, bank);
  const sessionPath = getSessionPath(config, bank);

  fs.mkdirSync(sessionDir, { recursive: true });

  if (!fs.existsSync(sessionPath)) {
    fs.writeFileSync(sessionPath, JSON.stringify({ cookies: [], origins: [] }));
  }

  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--disable-webgl", "--disable-software-rasterizer", "--no-sandbox"],
  });

  let storageState: string | undefined;
  try {
    const data = fs.readFileSync(sessionPath, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed.cookies || parsed.origins) {
      storageState = sessionPath;
    }
  } catch {
    // No valid session, start fresh
  }

  const context = await browser.newContext({
    storageState,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  sessions.set(bank, { browser, context, page });
  return page;
}

export async function saveBankSession(bank: string): Promise<void> {
  const session = sessions.get(bank);
  if (!session) return;

  const config = getBankConfig();
  const sessionPath = getSessionPath(config, bank);

  try {
    const state = await session.context.storageState();
    fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  } catch {
    // Silently fail if context is already closed
  }
}

export async function closeBankSession(bank: string): Promise<void> {
  const session = sessions.get(bank);
  if (!session) return;

  await saveBankSession(bank);
  await session.page.close().catch(() => {});
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
  sessions.delete(bank);
}

export async function waitForNavigation(page: Page, timeoutMs = 30000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForTimeout(1000);
}
