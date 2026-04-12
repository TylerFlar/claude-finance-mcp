import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBankPage, saveBankSession, waitForNavigation } from "./shared.js";

const BANK = "sofi";
const SOFI_URL = "https://www.sofi.com/wealth/app/banking";

export function registerSofiTools(server: McpServer): void {
  server.tool(
    "sofi_transfer",
    "Transfer money from SoFi checking account. Requires browser session — run setup:bank sofi first.",
    {
      to_account: z.string().describe("Destination: 'savings' or an external account name"),
      amount: z.number().positive().describe("Amount to transfer"),
      memo: z.string().optional().describe("Optional transfer memo"),
    },
    async ({ to_account, amount, memo }) => {
      try {
        const page = await getBankPage(BANK);
        await page.goto(SOFI_URL, { waitUntil: "domcontentloaded" });
        await waitForNavigation(page);

        // Check if logged in — if redirected to login page, session expired
        if (page.url().includes("login") || page.url().includes("signin")) {
          return {
            content: [{ type: "text", text: "SoFi session expired. Run setup:bank sofi to re-login." }],
            isError: true,
          };
        }

        // Navigate to transfer page
        const transferLink = page.locator("a[href*='transfer'], button:has-text('Transfer')").first();
        await transferLink.click({ timeout: 10000 });
        await waitForNavigation(page);

        // Fill transfer form
        // Select source account (checking)
        const fromSelect = page.locator("[data-testid='from-account'], select[name*='from']").first();
        if (await fromSelect.isVisible()) {
          const fromOptions = await fromSelect.locator("option").allTextContents();
          const fromMatch = fromOptions.find(o => /checking/i.test(o));
          if (fromMatch) await fromSelect.selectOption({ label: fromMatch });
        }

        // Select destination
        const toSelect = page.locator("[data-testid='to-account'], select[name*='to']").first();
        if (await toSelect.isVisible()) {
          const toOptions = await toSelect.locator("option").allTextContents();
          const toMatch = toOptions.find(o => new RegExp(to_account, "i").test(o));
          if (toMatch) await toSelect.selectOption({ label: toMatch });
        }

        // Enter amount
        const amountInput = page.locator("input[name*='amount'], input[type='number']").first();
        await amountInput.fill(amount.toFixed(2));

        // Enter memo if provided
        if (memo) {
          const memoInput = page.locator("input[name*='memo'], textarea[name*='memo']").first();
          if (await memoInput.isVisible()) {
            await memoInput.fill(memo);
          }
        }

        // Submit
        const submitBtn = page.locator("button[type='submit'], button:has-text('Review'), button:has-text('Continue')").first();
        await submitBtn.click();
        await waitForNavigation(page);

        // Confirm
        const confirmBtn = page.locator("button:has-text('Confirm'), button:has-text('Submit')").first();
        if (await confirmBtn.isVisible({ timeout: 5000 })) {
          await confirmBtn.click();
          await waitForNavigation(page);
        }

        // Extract confirmation
        const confirmText = await page.locator("[data-testid='confirmation'], .confirmation, .success").first().textContent().catch(() => null);

        await saveBankSession(BANK);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "submitted",
              confirmation_number: confirmText?.match(/\b[A-Z0-9]{6,}\b/)?.[0] || null,
              from: "SoFi Checking",
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
}
