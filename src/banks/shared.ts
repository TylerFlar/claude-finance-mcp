import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { BankConfig } from "../types.js";

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
