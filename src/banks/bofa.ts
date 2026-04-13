import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBankPage, saveBankSession, waitForNavigation } from "./shared.js";
import { scrapeBofaBalances, scrapeBofaTransactions, scrapeBofaCreditDueDate } from "./scrapers/index.js";

const BANK = "bofa";
const BOFA_URL = "https://www.bankofamerica.com/";
const BOFA_TRANSFER_URL = "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?source=overview&target=transfer";
const BOFA_BILLPAY_URL = "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?source=overview&target=billpay";

function checkLoggedIn(page: { url: () => string }): boolean {
  const url = page.url();
  return !url.includes("signin") && !url.includes("login") && url.includes("bankofamerica.com");
}

export function registerBofaTools(server: McpServer): void {
  // ─── bofa_balances ──────────────────────────────────────────────────────────

  server.tool(
    "bofa_balances",
    "Get Bank of America checking and credit card balances via browser scraping.",
    {},
    async () => {
      try {
        const page = await getBankPage(BANK);
        const balances = await scrapeBofaBalances(page);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(balances, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── bofa_transactions ──────────────────────────────────────────────────────

  server.tool(
    "bofa_transactions",
    "List recent Bank of America transactions via browser scraping.",
    {
      days_back: z.number().positive().default(30).describe("Number of days of history (default 30)"),
    },
    async ({ days_back }) => {
      try {
        const page = await getBankPage(BANK);
        const txns = await scrapeBofaTransactions(page, days_back);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── bofa_credit_due_date ───────────────────────────────────────────────────

  server.tool(
    "bofa_credit_due_date",
    "Get BofA credit card payment due date, statement balance, and minimum payment.",
    {},
    async () => {
      try {
        const page = await getBankPage(BANK);
        const dueDate = await scrapeBofaCreditDueDate(page);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(dueDate, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── bofa_transfer ───────────────────────────────────────────────────────────

  server.tool(
    "bofa_transfer",
    "Transfer money between Bank of America accounts. Requires browser session — run setup:bank bofa first.",
    {
      from_account: z.string().describe("Source account name (e.g. 'checking')"),
      to_account: z.string().describe("Destination account name"),
      amount: z.number().positive().describe("Amount to transfer"),
    },
    async ({ from_account, to_account, amount }) => {
      try {
        const page = await getBankPage(BANK);
        await page.goto(BOFA_TRANSFER_URL, { waitUntil: "domcontentloaded" });
        await waitForNavigation(page);

        if (!checkLoggedIn(page)) {
          return {
            content: [{ type: "text", text: "BofA session expired. Run setup:bank bofa to re-login." }],
            isError: true,
          };
        }

        // Select from account
        const fromSelect = page.locator("select[id*='from'], select[name*='from']").first();
        const fromOptions = await fromSelect.locator("option").allTextContents();
        const fromMatch = fromOptions.find(o => new RegExp(from_account, "i").test(o));
        if (fromMatch) await fromSelect.selectOption({ label: fromMatch });

        // Select to account
        const toSelect = page.locator("select[id*='to'], select[name*='to']").first();
        const toOptions = await toSelect.locator("option").allTextContents();
        const toMatch = toOptions.find(o => new RegExp(to_account, "i").test(o));
        if (toMatch) await toSelect.selectOption({ label: toMatch });

        // Enter amount
        const amountInput = page.locator("input[id*='amount'], input[name*='amount']").first();
        await amountInput.fill(amount.toFixed(2));

        // Submit
        const submitBtn = page.locator("button:has-text('Review'), button:has-text('Next'), input[type='submit']").first();
        await submitBtn.click();
        await waitForNavigation(page);

        // Confirm
        const confirmBtn = page.locator("button:has-text('Submit'), button:has-text('Confirm'), input[value*='ubmit']").first();
        if (await confirmBtn.isVisible({ timeout: 5000 })) {
          await confirmBtn.click();
          await waitForNavigation(page);
        }

        const confirmText = await page.locator(".confirmation-number, [class*='confirm']").first().textContent().catch(() => null);
        await saveBankSession(BANK);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "submitted",
              confirmation_number: confirmText?.match(/\b[A-Z0-9]{6,}\b/)?.[0] || null,
              from: from_account,
              to: to_account,
              amount,
            }, null, 2),
          }],
          isError: false,
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── bofa_pay_credit_card ────────────────────────────────────────────────────

  server.tool(
    "bofa_pay_credit_card",
    "Pay Bank of America credit card from BofA checking. Requires browser session — run setup:bank bofa first.",
    {
      amount: z.union([
        z.literal("statement"),
        z.literal("minimum"),
        z.number().positive(),
      ]).describe("'statement' for full balance, 'minimum' for minimum due, or a specific dollar amount"),
      from_account: z.string().default("checking").describe("Source account (default: checking)"),
    },
    async ({ amount, from_account }) => {
      try {
        const page = await getBankPage(BANK);
        await page.goto(BOFA_BILLPAY_URL, { waitUntil: "domcontentloaded" });
        await waitForNavigation(page);

        if (!checkLoggedIn(page)) {
          return {
            content: [{ type: "text", text: "BofA session expired. Run setup:bank bofa to re-login." }],
            isError: true,
          };
        }

        // Select payment source
        const fromSelect = page.locator("select[id*='from'], select[name*='from']").first();
        if (await fromSelect.isVisible()) {
          const payFromOptions = await fromSelect.locator("option").allTextContents();
          const payFromMatch = payFromOptions.find(o => new RegExp(from_account, "i").test(o));
          if (payFromMatch) await fromSelect.selectOption({ label: payFromMatch });
        }

        // Select amount type
        if (amount === "statement") {
          const stmtRadio = page.locator("input[value*='statement'], label:has-text('Statement balance')").first();
          await stmtRadio.click();
        } else if (amount === "minimum") {
          const minRadio = page.locator("input[value*='minimum'], label:has-text('Minimum')").first();
          await minRadio.click();
        } else {
          const otherRadio = page.locator("input[value*='other'], label:has-text('Other amount')").first();
          await otherRadio.click();
          const amountInput = page.locator("input[id*='amount'], input[name*='amount']").first();
          await amountInput.fill(amount.toFixed(2));
        }

        // Submit
        const submitBtn = page.locator("button:has-text('Review'), button:has-text('Next'), input[type='submit']").first();
        await submitBtn.click();
        await waitForNavigation(page);

        // Read actual amount from confirmation page
        const amountText = await page.locator("[class*='amount'], .payment-amount").first().textContent().catch(() => null);
        const paidAmount = amountText ? parseFloat(amountText.replace(/[$,]/g, "")) : (typeof amount === "number" ? amount : 0);

        // Confirm
        const confirmBtn = page.locator("button:has-text('Submit'), button:has-text('Confirm'), input[value*='ubmit']").first();
        if (await confirmBtn.isVisible({ timeout: 5000 })) {
          await confirmBtn.click();
          await waitForNavigation(page);
        }

        const confirmText = await page.locator(".confirmation-number, [class*='confirm']").first().textContent().catch(() => null);
        await saveBankSession(BANK);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "submitted",
              confirmation_number: confirmText?.match(/\b[A-Z0-9]{6,}\b/)?.[0] || null,
              amount_paid: paidAmount,
              from: from_account,
              card: "BofA Credit Card",
            }, null, 2),
          }],
          isError: false,
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
