import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPlaidClient, loadTokens } from "./client.js";
import type { Balance, Transaction, SpendingSummary, CreditDueDate, RecurringCharge } from "../types.js";

export function registerPlaidTools(server: McpServer): void {
  // ─── get_balances ────────────────────────────────────────────────────────────

  server.tool(
    "get_balances",
    "Get current balances across all linked bank accounts and credit cards via Plaid",
    {
      account_name: z.string().optional().describe("Filter to a specific account name"),
    },
    async ({ account_name }) => {
      try {
        const client = getPlaidClient();
        const tokens = loadTokens();
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No bank accounts linked. Run setup:plaid to connect banks." }], isError: true };
        }

        const balances: Balance[] = [];
        for (const token of tokens) {
          const response = await client.accountsBalanceGet({ access_token: token.access_token });
          for (const account of response.data.accounts) {
            const name = account.name || account.official_name || "Unknown";
            if (account_name && !name.toLowerCase().includes(account_name.toLowerCase())) continue;
            balances.push({
              institution: token.institution,
              account_name: name,
              type: account.type === "credit" ? "credit" : "checking",
              current_balance: account.balances.current ?? 0,
              available_balance: account.balances.available,
              currency: account.balances.iso_currency_code || "USD",
            });
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(balances, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── list_transactions ───────────────────────────────────────────────────────

  server.tool(
    "list_transactions",
    "List recent transactions across all linked accounts via Plaid",
    {
      days_back: z.number().int().default(30).describe("Number of days to look back (default 30)"),
      account_name: z.string().optional().describe("Filter to a specific account name"),
      category: z.string().optional().describe("Filter to a specific transaction category"),
    },
    async ({ days_back, account_name, category }) => {
      try {
        const client = getPlaidClient();
        const tokens = loadTokens();
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No bank accounts linked. Run setup:plaid to connect banks." }], isError: true };
        }

        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - days_back * 86400000).toISOString().slice(0, 10);

        const transactions: Transaction[] = [];
        for (const token of tokens) {
          const response = await client.transactionsGet({
            access_token: token.access_token,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, offset: 0 },
          });

          for (const tx of response.data.transactions) {
            const acctName = response.data.accounts.find(a => a.account_id === tx.account_id)?.name || "Unknown";
            if (account_name && !acctName.toLowerCase().includes(account_name.toLowerCase())) continue;
            const txCategory = tx.personal_finance_category?.primary || tx.category?.[0] || "Other";
            if (category && !txCategory.toLowerCase().includes(category.toLowerCase())) continue;

            transactions.push({
              date: tx.date,
              merchant: tx.merchant_name || tx.name || "Unknown",
              amount: tx.amount,
              category: txCategory,
              account_name: acctName,
              pending: tx.pending,
            });
          }
        }

        transactions.sort((a, b) => b.date.localeCompare(a.date));
        return { content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── spending_summary ────────────────────────────────────────────────────────

  server.tool(
    "spending_summary",
    "Get a spending summary by category and account for recent transactions",
    {
      days_back: z.number().int().default(30).describe("Number of days to look back (default 30)"),
      account_name: z.string().optional().describe("Filter to a specific account name"),
    },
    async ({ days_back, account_name }) => {
      try {
        const client = getPlaidClient();
        const tokens = loadTokens();
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No bank accounts linked. Run setup:plaid to connect banks." }], isError: true };
        }

        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - days_back * 86400000).toISOString().slice(0, 10);

        let totalSpent = 0;
        let totalIncome = 0;
        const byCategory: Record<string, number> = {};
        const byAccount: Record<string, number> = {};

        for (const token of tokens) {
          const response = await client.transactionsGet({
            access_token: token.access_token,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, offset: 0 },
          });

          for (const tx of response.data.transactions) {
            if (tx.pending) continue;
            const acctName = response.data.accounts.find(a => a.account_id === tx.account_id)?.name || "Unknown";
            if (account_name && !acctName.toLowerCase().includes(account_name.toLowerCase())) continue;

            const cat = tx.personal_finance_category?.primary || tx.category?.[0] || "Other";
            // Plaid: positive amounts = money spent, negative = income
            if (tx.amount > 0) {
              totalSpent += tx.amount;
            } else {
              totalIncome += Math.abs(tx.amount);
            }
            byCategory[cat] = (byCategory[cat] || 0) + tx.amount;
            byAccount[acctName] = (byAccount[acctName] || 0) + tx.amount;
          }
        }

        const summary: SpendingSummary = {
          total_spent: Math.round(totalSpent * 100) / 100,
          total_income: Math.round(totalIncome * 100) / 100,
          net: Math.round((totalIncome - totalSpent) * 100) / 100,
          by_category: Object.fromEntries(
            Object.entries(byCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])
          ),
          by_account: Object.fromEntries(
            Object.entries(byAccount).map(([k, v]) => [k, Math.round(v * 100) / 100])
          ),
        };

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── get_credit_due_dates ────────────────────────────────────────────────────

  server.tool(
    "get_credit_due_dates",
    "Get credit card statement balances, minimum payments, and due dates",
    {},
    async () => {
      try {
        const client = getPlaidClient();
        const tokens = loadTokens();
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No bank accounts linked. Run setup:plaid to connect banks." }], isError: true };
        }

        const dueDates: CreditDueDate[] = [];
        for (const token of tokens) {
          try {
            const response = await client.liabilitiesGet({ access_token: token.access_token });
            const creditCards = response.data.liabilities.credit || [];
            for (const card of creditCards) {
              const account = response.data.accounts.find(a => a.account_id === card.account_id);
              dueDates.push({
                institution: token.institution,
                account_name: account?.name || "Unknown",
                statement_balance: card.last_statement_balance,
                minimum_payment: card.minimum_payment_amount,
                due_date: card.next_payment_due_date || null,
              });
            }
          } catch {
            // Institution may not support liabilities — skip
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(dueDates, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── get_recurring ───────────────────────────────────────────────────────────

  server.tool(
    "get_recurring",
    "Get detected recurring charges and subscriptions across all linked accounts",
    {},
    async () => {
      try {
        const client = getPlaidClient();
        const tokens = loadTokens();
        if (tokens.length === 0) {
          return { content: [{ type: "text", text: "No bank accounts linked. Run setup:plaid to connect banks." }], isError: true };
        }

        const recurring: RecurringCharge[] = [];
        for (const token of tokens) {
          try {
            const response = await client.transactionsRecurringGet({
              access_token: token.access_token,
              account_ids: [],
            });

            for (const stream of [...response.data.outflow_streams, ...response.data.inflow_streams]) {
              recurring.push({
                merchant: stream.merchant_name || stream.description || "Unknown",
                amount: stream.average_amount?.amount ?? 0,
                frequency: stream.frequency?.toString() || "unknown",
                last_date: stream.last_date,
                account_name: stream.account_id,
              });
            }
          } catch {
            // Institution may not support recurring — skip
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(recurring, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
