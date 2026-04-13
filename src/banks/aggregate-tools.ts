import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBankPage, saveBankSession, BankSessionExpiredError } from "./shared.js";
import {
  scrapeSofiBalances, scrapeSofiTransactions,
  scrapeBofaBalances, scrapeBofaTransactions, scrapeBofaCreditDueDate,
  scrapeCapitalOneBalances, scrapeCapitalOneTransactions, scrapeCapitalOneCreditDueDate,
} from "./scrapers/index.js";
import type { Balance, Transaction, SpendingSummary, CreditDueDate, RecurringCharge, BankScrapeError } from "../types.js";

const ALL_BANKS = ["sofi", "bofa", "capitalone"] as const;
type BankName = (typeof ALL_BANKS)[number];

interface ScrapeResult<T> {
  data: T;
  errors: BankScrapeError[];
}

function bankError(bank: string, e: unknown): BankScrapeError {
  const sessionExpired = e instanceof BankSessionExpiredError;
  return {
    bank,
    error: e instanceof Error ? e.message : String(e),
    sessionExpired,
  };
}

function formatResponse(data: unknown, errors: BankScrapeError[]): { content: { type: "text"; text: string }[]; isError: boolean } {
  const allFailed = errors.length > 0 && (Array.isArray(data) ? (data as unknown[]).length === 0 : !data);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ data, errors }, null, 2) }],
    isError: allFailed,
  };
}

// ─── get_balances ──────────────────────────────────────────────────────────────

async function scrapeBalances(banks: readonly BankName[]): Promise<ScrapeResult<Balance[]>> {
  const results: Balance[] = [];
  const errors: BankScrapeError[] = [];

  for (const bank of banks) {
    try {
      const page = await getBankPage(bank);
      let balances: Balance[];
      switch (bank) {
        case "sofi": balances = await scrapeSofiBalances(page); break;
        case "bofa": balances = await scrapeBofaBalances(page); break;
        case "capitalone": balances = await scrapeCapitalOneBalances(page); break;
      }
      results.push(...balances);
      await saveBankSession(bank);
    } catch (e) {
      errors.push(bankError(bank, e));
    }
  }

  return { data: results, errors };
}

// ─── list_transactions ─────────────────────────────────────────────────────────

async function scrapeTransactions(
  banks: readonly BankName[],
  daysBack: number,
  accountName?: string,
): Promise<ScrapeResult<Transaction[]>> {
  const results: Transaction[] = [];
  const errors: BankScrapeError[] = [];

  for (const bank of banks) {
    try {
      const page = await getBankPage(bank);
      let txns: Transaction[];
      switch (bank) {
        case "sofi": txns = await scrapeSofiTransactions(page, daysBack); break;
        case "bofa": txns = await scrapeBofaTransactions(page, daysBack); break;
        case "capitalone": txns = await scrapeCapitalOneTransactions(page, daysBack); break;
      }
      results.push(...txns);
      await saveBankSession(bank);
    } catch (e) {
      errors.push(bankError(bank, e));
    }
  }

  let filtered = results;
  if (accountName) {
    const pat = new RegExp(accountName, "i");
    filtered = filtered.filter(t => pat.test(t.account_name));
  }
  filtered.sort((a, b) => b.date.localeCompare(a.date));

  return { data: filtered, errors };
}

// ─── spending_summary ──────────────────────────────────────────────────────────

function computeSummary(transactions: Transaction[]): SpendingSummary {
  let totalSpent = 0;
  let totalIncome = 0;
  const byCategory: Record<string, number> = {};
  const byAccount: Record<string, number> = {};

  for (const tx of transactions) {
    if (tx.pending) continue;
    // Positive amount = spending, negative = income (refund/credit)
    if (tx.amount > 0) {
      totalSpent += tx.amount;
    } else {
      totalIncome += Math.abs(tx.amount);
    }
    byCategory[tx.category] = (byCategory[tx.category] || 0) + tx.amount;
    byAccount[tx.account_name] = (byAccount[tx.account_name] || 0) + tx.amount;
  }

  return {
    total_spent: totalSpent,
    total_income: totalIncome,
    net: totalIncome - totalSpent,
    by_category: byCategory,
    by_account: byAccount,
  };
}

// ─── get_recurring ─────────────────────────────────────────────────────────────

function detectRecurring(transactions: Transaction[]): RecurringCharge[] {
  // Group by normalized merchant name
  const byMerchant = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.pending) continue;
    const key = tx.merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    const list = byMerchant.get(key) || [];
    list.push(tx);
    byMerchant.set(key, list);
  }

  const recurring: RecurringCharge[] = [];

  for (const [, txns] of byMerchant) {
    if (txns.length < 2) continue;

    // Check if amounts are similar (within 10%)
    const amounts = txns.map(t => t.amount);
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const allSimilar = amounts.every(a => Math.abs(a - avgAmount) / avgAmount < 0.1);
    if (!allSimilar) continue;

    // Check if intervals are roughly regular (25-35 days for monthly)
    const dates = txns
      .map(t => new Date(t.date).getTime())
      .filter(d => !isNaN(d))
      .sort((a, b) => a - b);

    if (dates.length < 2) continue;

    const intervals: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      intervals.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
    }
    const avgInterval = intervals.reduce((s, i) => s + i, 0) / intervals.length;

    let frequency: string;
    if (avgInterval >= 6 && avgInterval <= 8) frequency = "weekly";
    else if (avgInterval >= 13 && avgInterval <= 16) frequency = "biweekly";
    else if (avgInterval >= 25 && avgInterval <= 35) frequency = "monthly";
    else if (avgInterval >= 55 && avgInterval <= 65) frequency = "bimonthly";
    else if (avgInterval >= 85 && avgInterval <= 100) frequency = "quarterly";
    else continue; // Not a recognizable pattern

    const latest = txns.sort((a, b) => b.date.localeCompare(a.date))[0];
    recurring.push({
      merchant: latest.merchant,
      amount: Math.round(avgAmount * 100) / 100,
      frequency,
      last_date: latest.date,
      account_name: latest.account_name,
    });
  }

  return recurring.sort((a, b) => b.amount - a.amount);
}

// ─── Register Tools ────────────────────────────────────────────────────────────

export function registerAggregateTools(server: McpServer): void {
  server.tool(
    "get_balances",
    "Get account balances across all banks (SoFi, BofA, Capital One) via browser scraping. Requires active browser sessions.",
    {
      bank: z.enum(["sofi", "bofa", "capitalone"]).optional().describe("Scrape only this bank (default: all)"),
    },
    async ({ bank }) => {
      const banks = bank ? [bank] as const : ALL_BANKS;
      const { data, errors } = await scrapeBalances(banks);
      return formatResponse(data, errors);
    },
  );

  server.tool(
    "list_transactions",
    "List recent transactions across all banks via browser scraping. Date range depends on what each bank UI shows (typically 30-90 days).",
    {
      days_back: z.number().positive().default(30).describe("Number of days of history (default 30)"),
      account_name: z.string().optional().describe("Filter by account name (regex match)"),
      bank: z.enum(["sofi", "bofa", "capitalone"]).optional().describe("Scrape only this bank (default: all)"),
    },
    async ({ days_back, account_name, bank }) => {
      const banks = bank ? [bank] as const : ALL_BANKS;
      const { data, errors } = await scrapeTransactions(banks, days_back, account_name);
      return formatResponse(data, errors);
    },
  );

  server.tool(
    "spending_summary",
    "Compute spending summary from scraped transactions. Categories may be limited since bank UIs don't always categorize transactions.",
    {
      days_back: z.number().positive().default(30).describe("Number of days of history (default 30)"),
      account_name: z.string().optional().describe("Filter by account name (regex match)"),
    },
    async ({ days_back, account_name }) => {
      const { data: transactions, errors } = await scrapeTransactions(ALL_BANKS, days_back, account_name);
      const summary = computeSummary(transactions);
      return formatResponse(summary, errors);
    },
  );

  server.tool(
    "get_credit_due_dates",
    "Get credit card payment due dates, statement balances, and minimum payments from BofA and Capital One.",
    {},
    async () => {
      const results: CreditDueDate[] = [];
      const errors: BankScrapeError[] = [];

      for (const bank of ["bofa", "capitalone"] as const) {
        try {
          const page = await getBankPage(bank);
          let dueDate: CreditDueDate | null;
          switch (bank) {
            case "bofa": dueDate = await scrapeBofaCreditDueDate(page); break;
            case "capitalone": dueDate = await scrapeCapitalOneCreditDueDate(page); break;
          }
          if (dueDate) results.push(dueDate);
          await saveBankSession(bank);
        } catch (e) {
          errors.push(bankError(bank, e));
        }
      }

      return formatResponse(results, errors);
    },
  );

  server.tool(
    "get_recurring",
    "Detect recurring charges by analyzing 90 days of transaction history. Uses heuristic pattern matching (repeated merchant + similar amount + regular interval).",
    {},
    async () => {
      const { data: transactions, errors } = await scrapeTransactions(ALL_BANKS, 90);
      const recurring = detectRecurring(transactions);
      return formatResponse(recurring, errors);
    },
  );
}
