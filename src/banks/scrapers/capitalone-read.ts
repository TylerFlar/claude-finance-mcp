import type { Page } from "playwright";
import type { Balance, Transaction, CreditDueDate } from "../../types.js";
import { ensureLoggedIn, parseDollarAmount, parseTransactionDate, waitForNavigation } from "../shared.js";

const BANK = "capitalone";
const CAPITALONE_URL = "https://myaccounts.capitalone.com/accountSummary";

export async function scrapeCapitalOneBalances(page: Page): Promise<Balance[]> {
  await page.goto(CAPITALONE_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await ensureLoggedIn(page, BANK);

  const balances: Balance[] = [];

  // Capital One account summary shows credit card(s) with balance and available credit
  const accountCards = page.locator(
    "[data-testid*='account'], [class*='AccountCard'], [class*='account-tile'], [class*='account-summary']"
  );
  const count = await accountCards.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const card = accountCards.nth(i);
    const text = await card.textContent().catch(() => "") || "";

    // Look for balance amount
    const balanceMatch = text.match(/[Cc]urrent\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)/);
    const currentBalance = balanceMatch ? parseDollarAmount("$" + balanceMatch[1]) : null;

    // Look for available credit
    const availMatch = text.match(/[Aa]vailable\s*[Cc]redit[\s:]*\$?([\d,]+\.?\d*)/);
    const availableCredit = availMatch ? parseDollarAmount("$" + availMatch[1]) : null;

    // Extract card name
    const nameMatch = text.match(/([\w\s]+?)(?:Current|Available|\$|\d)/);
    const cardName = nameMatch ? nameMatch[1].trim() : "Capital One Credit Card";

    if (currentBalance !== null || availableCredit !== null) {
      balances.push({
        institution: "Capital One",
        account_name: cardName || "Capital One Credit Card",
        type: "credit",
        current_balance: currentBalance ?? 0,
        available_balance: availableCredit,
        currency: "USD",
      });
    }
  }

  // Fallback: scan page text
  if (balances.length === 0) {
    const bodyText = await page.locator("main, [role='main'], body").first().textContent().catch(() => "") || "";
    const balanceMatch = bodyText.match(/[Bb]alance[\s:]*\$?([\d,]+\.\d{2})/);
    if (balanceMatch) {
      balances.push({
        institution: "Capital One",
        account_name: "Capital One Credit Card",
        type: "credit",
        current_balance: parseDollarAmount("$" + balanceMatch[1]) ?? 0,
        available_balance: null,
        currency: "USD",
      });
    }
  }

  return balances;
}

export async function scrapeCapitalOneTransactions(page: Page, daysBack: number): Promise<Transaction[]> {
  // Navigate to account detail for transactions
  await page.goto(CAPITALONE_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await ensureLoggedIn(page, BANK);

  // Click into the credit card account
  const cardLink = page.locator("a[href*='credit'], [data-testid*='credit-card'], a[class*='account']").first();
  const hasCard = await cardLink.isVisible({ timeout: 5000 }).catch(() => false);
  if (hasCard) {
    await cardLink.click();
    await waitForNavigation(page);
  }

  // Look for activity/transactions tab
  const activityTab = page.locator(
    "a:has-text('Activity'), button:has-text('Activity'), a:has-text('Transactions'), [data-testid*='activity']"
  ).first();
  const hasTab = await activityTab.isVisible({ timeout: 3000 }).catch(() => false);
  if (hasTab) {
    await activityTab.click();
    await waitForNavigation(page);
  }

  const transactions: Transaction[] = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  // Scrape transaction rows
  const rows = page.locator(
    "[data-testid*='transaction'], .transaction-row, [class*='TransactionRow'], [class*='activity-row'], tr[class*='transaction']"
  );
  const rowCount = await rows.count().catch(() => 0);

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const text = await row.textContent().catch(() => "") || "";

    const dateStr = parseTransactionDate(text);
    if (dateStr) {
      const txDate = new Date(dateStr);
      if (txDate < cutoff) continue;
    }

    const amountMatch = text.match(/-?\$[\d,]+\.?\d*/);
    const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;

    // Capital One sometimes shows category
    let category = "Uncategorized";
    const categoryMatch = text.match(/(?:Category|Type)[\s:]*([A-Za-z\s&]+?)(?:\$|\d|$)/i);
    if (categoryMatch) category = categoryMatch[1].trim();

    let merchant = text
      .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, "")
      .replace(/[A-Z][a-z]+\s+\d{1,2},?\s*\d{0,4}/g, "")
      .replace(/-?\$[\d,]+\.?\d*/g, "")
      .replace(/pending/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (amount !== null && merchant) {
      transactions.push({
        date: dateStr || new Date().toISOString().slice(0, 10),
        merchant,
        amount: Math.abs(amount),
        category,
        account_name: "Capital One Credit Card",
        pending: /pending/i.test(text),
      });
    }
  }

  return transactions;
}

export async function scrapeCapitalOneCreditDueDate(page: Page): Promise<CreditDueDate | null> {
  await page.goto(CAPITALONE_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await ensureLoggedIn(page, BANK);

  // Click into credit card for payment info
  const cardLink = page.locator("a[href*='credit'], [data-testid*='credit-card'], a[class*='account']").first();
  const hasCard = await cardLink.isVisible({ timeout: 5000 }).catch(() => false);
  if (hasCard) {
    await cardLink.click();
    await waitForNavigation(page);
  }

  const bodyText = await page.locator("main, [role='main'], body").first().textContent().catch(() => "") || "";

  // Extract due date
  const dueDateMatch = bodyText.match(
    /[Pp]ayment\s*[Dd]ue[\s:]*([A-Za-z]+\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/
  );
  const dueDate = dueDateMatch ? parseTransactionDate(dueDateMatch[1]) : null;

  // Extract statement balance
  const stmtMatch = bodyText.match(/[Ss]tatement\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)/);
  const statementBalance = stmtMatch ? parseDollarAmount("$" + stmtMatch[1]) : null;

  // Extract minimum payment
  const minMatch = bodyText.match(/[Mm]inimum\s*[Pp]ayment[\s:]*\$?([\d,]+\.?\d*)/);
  const minimumPayment = minMatch ? parseDollarAmount("$" + minMatch[1]) : null;

  if (!dueDate && statementBalance === null && minimumPayment === null) return null;

  return {
    institution: "Capital One",
    account_name: "Capital One Credit Card",
    statement_balance: statementBalance,
    minimum_payment: minimumPayment,
    due_date: dueDate,
  };
}
