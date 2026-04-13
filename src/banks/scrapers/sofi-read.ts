import type { Page } from "playwright";
import type { Balance, Transaction } from "../../types.js";
import { ensureLoggedIn, parseDollarAmount, parseTransactionDate, waitForNavigation } from "../shared.js";

const BANK = "sofi";
const SOFI_BANKING_URL = "https://www.sofi.com/wealth/app/banking";

export async function scrapeSofiBalances(page: Page): Promise<Balance[]> {
  await page.goto(SOFI_BANKING_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await ensureLoggedIn(page, BANK);

  const balances: Balance[] = [];

  // SoFi banking dashboard shows account cards with name and balance
  const accountCards = page.locator(
    "[data-testid*='account'], .account-card, [class*='AccountCard'], [class*='account-tile']"
  );
  const count = await accountCards.count().catch(() => 0);

  if (count > 0) {
    for (let i = 0; i < count; i++) {
      const card = accountCards.nth(i);
      const text = await card.textContent().catch(() => "") || "";
      const isChecking = /checking/i.test(text);
      const isSavings = /savings/i.test(text);
      if (!isChecking && !isSavings) continue;

      const amountMatch = text.match(/\$[\d,]+\.?\d*/);
      const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;

      balances.push({
        institution: "SoFi",
        account_name: isChecking ? "SoFi Checking" : "SoFi Savings",
        type: "checking",
        current_balance: amount ?? 0,
        available_balance: amount,
        currency: "USD",
      });
    }
  }

  // Fallback: scan the page text for balance patterns
  if (balances.length === 0) {
    const bodyText = await page.locator("main, [role='main'], body").first().textContent().catch(() => "") || "";

    for (const acctType of ["Checking", "Savings"] as const) {
      const regex = new RegExp(`${acctType}[\\s\\S]{0,100}?(\\$[\\d,]+\\.\\d{2})`, "i");
      const match = bodyText.match(regex);
      if (match) {
        balances.push({
          institution: "SoFi",
          account_name: `SoFi ${acctType}`,
          type: "checking",
          current_balance: parseDollarAmount(match[1]) ?? 0,
          available_balance: parseDollarAmount(match[1]),
          currency: "USD",
        });
      }
    }
  }

  return balances;
}

export async function scrapeSofiTransactions(page: Page, daysBack: number): Promise<Transaction[]> {
  // Navigate to activity view
  const activityLink = page.locator("a[href*='activity'], a:has-text('Activity'), button:has-text('Activity')").first();
  const hasActivity = await activityLink.isVisible({ timeout: 3000 }).catch(() => false);
  if (hasActivity) {
    await activityLink.click();
    await waitForNavigation(page);
  } else {
    // Try direct navigation
    await page.goto(SOFI_BANKING_URL + "/activity", { waitUntil: "domcontentloaded" });
    await waitForNavigation(page);
  }
  await ensureLoggedIn(page, BANK);

  const transactions: Transaction[] = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  // Scrape transaction rows
  const rows = page.locator(
    "[data-testid*='transaction'], .transaction-row, [class*='TransactionRow'], [class*='transaction-item'], tr[class*='transaction']"
  );
  const rowCount = await rows.count().catch(() => 0);

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const text = await row.textContent().catch(() => "") || "";

    // Extract date
    const dateStr = parseTransactionDate(text);
    if (dateStr) {
      const txDate = new Date(dateStr);
      if (txDate < cutoff) continue;
    }

    // Extract amount
    const amountMatch = text.match(/-?\$[\d,]+\.?\d*/);
    const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;

    // Extract merchant/description — the text minus the date and amount
    let merchant = text
      .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, "")
      .replace(/[A-Z][a-z]+\s+\d{1,2},?\s*\d{0,4}/g, "")
      .replace(/-?\$[\d,]+\.?\d*/g, "")
      .replace(/pending/gi, "")
      .trim();
    // Clean up whitespace
    merchant = merchant.replace(/\s+/g, " ").trim();

    if (amount !== null && merchant) {
      transactions.push({
        date: dateStr || new Date().toISOString().slice(0, 10),
        merchant,
        amount: Math.abs(amount),
        category: "Uncategorized",
        account_name: "SoFi Checking",
        pending: /pending/i.test(text),
      });
    }
  }

  return transactions;
}
