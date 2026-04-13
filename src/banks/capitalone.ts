import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBankPage, saveBankSession, waitForNavigation } from "./shared.js";
import { scrapeCapitalOneBalances, scrapeCapitalOneTransactions, scrapeCapitalOneCreditDueDate } from "./scrapers/index.js";

const BANK = "capitalone";
const CAPITALONE_URL = "https://myaccounts.capitalone.com/accountSummary";

export function registerCapitalOneTools(server: McpServer): void {
  // ─── capitalone_balances ────────────────────────────────────────────────────

  server.tool(
    "capitalone_balances",
    "Get Capital One credit card balance via browser scraping.",
    {},
    async () => {
      try {
        const page = await getBankPage(BANK);
        const balances = await scrapeCapitalOneBalances(page);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(balances, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── capitalone_transactions ────────────────────────────────────────────────

  server.tool(
    "capitalone_transactions",
    "List recent Capital One transactions via browser scraping.",
    {
      days_back: z.number().positive().default(30).describe("Number of days of history (default 30)"),
    },
    async ({ days_back }) => {
      try {
        const page = await getBankPage(BANK);
        const txns = await scrapeCapitalOneTransactions(page, days_back);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── capitalone_credit_due_date ─────────────────────────────────────────────

  server.tool(
    "capitalone_credit_due_date",
    "Get Capital One credit card payment due date, statement balance, and minimum payment.",
    {},
    async () => {
      try {
        const page = await getBankPage(BANK);
        const dueDate = await scrapeCapitalOneCreditDueDate(page);
        await saveBankSession(BANK);
        return { content: [{ type: "text", text: JSON.stringify(dueDate, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );

  // ─── capitalone_pay ─────────────────────────────────────────────────────────

  server.tool(
    "capitalone_pay",
    "Pay Capital One credit card. Requires browser session — run setup:bank capitalone first.",
    {
      amount: z.union([
        z.literal("statement"),
        z.literal("minimum"),
        z.number().positive(),
      ]).describe("'statement' for full balance, 'minimum' for minimum due, or a specific dollar amount"),
      from_bank: z.string().default("external").describe("Payment source bank (default: linked external account)"),
    },
    async ({ amount, from_bank }) => {
      try {
        const page = await getBankPage(BANK);
        await page.goto(CAPITALONE_URL, { waitUntil: "domcontentloaded" });
        await waitForNavigation(page);

        // Check if logged in
        if (page.url().includes("signin") || page.url().includes("login")) {
          return {
            content: [{ type: "text", text: "Capital One session expired. Run setup:bank capitalone to re-login." }],
            isError: true,
          };
        }

        // Navigate to credit card and make payment
        const cardLink = page.locator("a[href*='credit'], [data-testid*='credit-card']").first();
        await cardLink.click({ timeout: 10000 });
        await waitForNavigation(page);

        // Click Make Payment
        const payBtn = page.locator("button:has-text('Make a Payment'), a:has-text('Make a Payment'), button:has-text('Pay')").first();
        await payBtn.click({ timeout: 10000 });
        await waitForNavigation(page);

        // Select payment source if visible
        const fromSelect = page.locator("select[id*='from'], select[name*='bank'], [data-testid*='payment-source']").first();
        if (await fromSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
          const capFromOptions = await fromSelect.locator("option").allTextContents();
          const capFromMatch = capFromOptions.find(o => new RegExp(from_bank, "i").test(o));
          if (capFromMatch) await fromSelect.selectOption({ label: capFromMatch });
        }

        // Select amount type
        if (amount === "statement") {
          const stmtOption = page.locator("input[value*='statement'], label:has-text('Statement'), button:has-text('Statement')").first();
          await stmtOption.click();
        } else if (amount === "minimum") {
          const minOption = page.locator("input[value*='minimum'], label:has-text('Minimum'), button:has-text('Minimum')").first();
          await minOption.click();
        } else {
          const otherOption = page.locator("input[value*='other'], label:has-text('Other'), button:has-text('Other')").first();
          await otherOption.click();
          const amountInput = page.locator("input[id*='amount'], input[name*='amount'], input[type='number']").first();
          await amountInput.fill(amount.toFixed(2));
        }

        // Submit / Review
        const submitBtn = page.locator("button:has-text('Review'), button:has-text('Continue'), button[type='submit']").first();
        await submitBtn.click();
        await waitForNavigation(page);

        // Read actual amount
        const amountText = await page.locator("[class*='amount'], [data-testid*='amount']").first().textContent().catch(() => null);
        const paidAmount = amountText ? parseFloat(amountText.replace(/[$,]/g, "")) : (typeof amount === "number" ? amount : 0);

        // Confirm
        const confirmBtn = page.locator("button:has-text('Submit'), button:has-text('Confirm')").first();
        if (await confirmBtn.isVisible({ timeout: 5000 })) {
          await confirmBtn.click();
          await waitForNavigation(page);
        }

        const confirmText = await page.locator("[class*='confirm'], [data-testid*='confirm']").first().textContent().catch(() => null);
        await saveBankSession(BANK);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "submitted",
              confirmation_number: confirmText?.match(/\b[A-Z0-9]{6,}\b/)?.[0] || null,
              amount_paid: paidAmount,
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
