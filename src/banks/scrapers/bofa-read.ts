import type { Page } from "playwright";
import type { Balance, Transaction, CreditDueDate } from "../../types.js";
import { ensureLoggedIn, parseDollarAmount, parseTransactionDate, waitForNavigation } from "../shared.js";

const BANK = "bofa";
const BOFA_OVERVIEW_URL = "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?source=overview&target=accountsoverview";

function checkBofaLoggedIn(url: string): boolean {
  return !url.includes("signin") && !url.includes("login") && url.includes("bankofamerica.com");
}

export async function scrapeBofaBalances(page: Page): Promise<Balance[]> {
  await page.goto(BOFA_OVERVIEW_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  if (!checkBofaLoggedIn(page.url())) {
    await ensureLoggedIn(page, BANK);
  }

  const balances: Balance[] = [];

  // BofA overview page groups accounts under headings
  // Bank Accounts section
  const bankSection = page.locator(
    "[id*='bankAccounts'], [class*='bank-accounts'], :has-text('Bank Accounts') >> xpath=.."
  ).first();
  const bankRows = bankSection.locator("[class*='AccountItem'], [class*='account-row'], li, tr");
  const bankCount = await bankRows.count().catch(() => 0);

  for (let i = 0; i < bankCount; i++) {
    const row = bankRows.nth(i);
    const text = await row.textContent().catch(() => "") || "";
    if (!/checking|savings/i.test(text)) continue;

    const amountMatch = text.match(/\$[\d,]+\.?\d*/);
    const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;
    const isChecking = /checking/i.test(text);

    balances.push({
      institution: "Bank of America",
      account_name: isChecking ? "BofA Checking" : "BofA Savings",
      type: "checking",
      current_balance: amount ?? 0,
      available_balance: amount,
      currency: "USD",
    });
  }

  // Credit Cards section
  const creditSection = page.locator(
    "[id*='creditCard'], [class*='credit-card'], :has-text('Credit Cards') >> xpath=.."
  ).first();
  const creditRows = creditSection.locator("[class*='AccountItem'], [class*='account-row'], li, tr");
  const creditCount = await creditRows.count().catch(() => 0);

  for (let i = 0; i < creditCount; i++) {
    const row = creditRows.nth(i);
    const text = await row.textContent().catch(() => "") || "";
    const amountMatch = text.match(/\$[\d,]+\.?\d*/);
    const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;

    // Try to extract card name
    const nameMatch = text.match(/^([A-Za-z\s]+?)(?:\d|\.|\$)/);
    const cardName = nameMatch ? nameMatch[1].trim() : "BofA Credit Card";

    balances.push({
      institution: "Bank of America",
      account_name: cardName || "BofA Credit Card",
      type: "credit",
      current_balance: amount ?? 0,
      available_balance: null,
      currency: "USD",
    });
  }

  // Fallback: scan full page
  if (balances.length === 0) {
    const bodyText = await page.locator("main, #main-content, body").first().textContent().catch(() => "") || "";
    const checkingMatch = bodyText.match(/[Cc]hecking[\s\S]{0,100}?(\$[\d,]+\.\d{2})/);
    if (checkingMatch) {
      balances.push({
        institution: "Bank of America",
        account_name: "BofA Checking",
        type: "checking",
        current_balance: parseDollarAmount(checkingMatch[1]) ?? 0,
        available_balance: parseDollarAmount(checkingMatch[1]),
        currency: "USD",
      });
    }
    const creditMatch = bodyText.match(/[Cc]redit\s*[Cc]ard[\s\S]{0,100}?(\$[\d,]+\.\d{2})/);
    if (creditMatch) {
      balances.push({
        institution: "Bank of America",
        account_name: "BofA Credit Card",
        type: "credit",
        current_balance: parseDollarAmount(creditMatch[1]) ?? 0,
        available_balance: null,
        currency: "USD",
      });
    }
  }

  return balances;
}

export async function scrapeBofaTransactions(page: Page, daysBack: number): Promise<Transaction[]> {
  // Start from overview, click into checking account
  await page.goto(BOFA_OVERVIEW_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  if (!checkBofaLoggedIn(page.url())) {
    await ensureLoggedIn(page, BANK);
  }

  const transactions: Transaction[] = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  // Click into checking account
  const checkingLink = page.locator("a:has-text('Checking'), a[class*='account-name']:has-text('Checking')").first();
  const hasChecking = await checkingLink.isVisible({ timeout: 5000 }).catch(() => false);

  if (hasChecking) {
    await checkingLink.click();
    await waitForNavigation(page);
    await scrapeTransactionRows(page, transactions, "BofA Checking", cutoff);
    // Go back for credit card
    await page.goBack();
    await waitForNavigation(page);
  }

  // Click into credit card account
  const creditLink = page.locator(
    "a:has-text('Credit Card'), a:has-text('Cash Rewards'), a[class*='account-name']:has-text('Credit')"
  ).first();
  const hasCredit = await creditLink.isVisible({ timeout: 5000 }).catch(() => false);

  if (hasCredit) {
    await creditLink.click();
    await waitForNavigation(page);
    await scrapeTransactionRows(page, transactions, "BofA Credit Card", cutoff);
  }

  return transactions;
}

async function scrapeTransactionRows(
  page: Page,
  out: Transaction[],
  accountName: string,
  cutoff: Date,
): Promise<void> {
  const rows = page.locator(
    "[data-testid*='transaction'], .transaction-row, [class*='TransactionRow'], tr.transaction, [class*='activity-row']"
  );
  const count = await rows.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const text = await row.textContent().catch(() => "") || "";

    const dateStr = parseTransactionDate(text);
    if (dateStr) {
      const txDate = new Date(dateStr);
      if (txDate < cutoff) continue;
    }

    const amountMatch = text.match(/-?\$[\d,]+\.?\d*/);
    const amount = amountMatch ? parseDollarAmount(amountMatch[0]) : null;

    let merchant = text
      .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, "")
      .replace(/[A-Z][a-z]+\s+\d{1,2},?\s*\d{0,4}/g, "")
      .replace(/-?\$[\d,]+\.?\d*/g, "")
      .replace(/pending/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (amount !== null && merchant) {
      out.push({
        date: dateStr || new Date().toISOString().slice(0, 10),
        merchant,
        amount: Math.abs(amount),
        category: "Uncategorized",
        account_name: accountName,
        pending: /pending/i.test(text),
      });
    }
  }
}

export async function scrapeBofaCreditDueDate(page: Page): Promise<CreditDueDate | null> {
  // Navigate to overview and find credit card info
  await page.goto(BOFA_OVERVIEW_URL, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  if (!checkBofaLoggedIn(page.url())) {
    await ensureLoggedIn(page, BANK);
  }

  // Click into credit card
  const creditLink = page.locator(
    "a:has-text('Credit Card'), a:has-text('Cash Rewards'), a[class*='account-name']:has-text('Credit')"
  ).first();
  const hasCredit = await creditLink.isVisible({ timeout: 5000 }).catch(() => false);
  if (!hasCredit) return null;

  await creditLink.click();
  await waitForNavigation(page);

  const bodyText = await page.locator("main, #main-content, body").first().textContent().catch(() => "") || "";

  // Extract due date
  const dueDateMatch = bodyText.match(/[Pp]ayment\s*[Dd]ue\s*[Dd]ate[\s:]*([A-Za-z]+\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
  const dueDate = dueDateMatch ? parseTransactionDate(dueDateMatch[1]) : null;

  // Extract statement balance
  const stmtMatch = bodyText.match(/[Ss]tatement\s*[Bb]alance[\s:]*\$?([\d,]+\.?\d*)/);
  const statementBalance = stmtMatch ? parseDollarAmount("$" + stmtMatch[1]) : null;

  // Extract minimum payment
  const minMatch = bodyText.match(/[Mm]inimum\s*[Pp]ayment[\s:]*\$?([\d,]+\.?\d*)/);
  const minimumPayment = minMatch ? parseDollarAmount("$" + minMatch[1]) : null;

  return {
    institution: "Bank of America",
    account_name: "BofA Credit Card",
    statement_balance: statementBalance,
    minimum_payment: minimumPayment,
    due_date: dueDate,
  };
}
