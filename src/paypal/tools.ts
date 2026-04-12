import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { paypalFetch } from "./client.js";

export function registerPaypalTools(server: McpServer): void {
  // ─── paypal_balance ──────────────────────────────────────────────────────────

  server.tool(
    "paypal_balance",
    "Get current PayPal account balance",
    {},
    async () => {
      try {
        const response = await paypalFetch("/v1/reporting/balances?as_of_time=" + new Date().toISOString());
        if (!response.ok) {
          return { content: [{ type: "text", text: `PayPal API error: ${response.status} ${await response.text()}` }], isError: true };
        }
        const data = await response.json() as {
          balances: Array<{
            currency: string;
            total_balance: { currency_code: string; value: string };
            available_balance: { currency_code: string; value: string };
          }>;
        };

        const result = data.balances.map(b => ({
          currency: b.currency,
          available: parseFloat(b.available_balance.value),
          total: parseFloat(b.total_balance.value),
        }));

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── paypal_transactions ─────────────────────────────────────────────────────

  server.tool(
    "paypal_transactions",
    "List recent PayPal transactions",
    {
      days_back: z.number().int().default(30).describe("Number of days to look back (default 30)"),
    },
    async ({ days_back }) => {
      try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days_back * 86400000).toISOString();

        const response = await paypalFetch(
          `/v1/reporting/transactions?start_date=${startDate}&end_date=${endDate}&fields=all&page_size=100`
        );
        if (!response.ok) {
          return { content: [{ type: "text", text: `PayPal API error: ${response.status} ${await response.text()}` }], isError: true };
        }

        const data = await response.json() as {
          transaction_details: Array<{
            transaction_info: {
              transaction_event_code: string;
              transaction_initiation_date: string;
              transaction_amount: { currency_code: string; value: string };
              transaction_status: string;
            };
            payer_info?: { payer_name?: { alternate_full_name?: string }; email_address?: string };
            cart_info?: { item_details?: Array<{ item_name?: string }> };
          }>;
        };

        const transactions = data.transaction_details.map(d => ({
          date: d.transaction_info.transaction_initiation_date,
          type: d.transaction_info.transaction_event_code,
          amount: parseFloat(d.transaction_info.transaction_amount.value),
          currency: d.transaction_info.transaction_amount.currency_code,
          name: d.payer_info?.payer_name?.alternate_full_name || "Unknown",
          email: d.payer_info?.email_address || null,
          status: d.transaction_info.transaction_status,
        }));

        return { content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }], isError: false };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── paypal_commission_income ────────────────────────────────────────────────

  server.tool(
    "paypal_commission_income",
    "Get incoming PayPal payments (commission income tracking)",
    {
      days_back: z.number().int().default(30).describe("Number of days to look back (default 30)"),
    },
    async ({ days_back }) => {
      try {
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days_back * 86400000).toISOString();

        const response = await paypalFetch(
          `/v1/reporting/transactions?start_date=${startDate}&end_date=${endDate}&fields=all&page_size=100&transaction_type=T0006`
        );
        if (!response.ok) {
          return { content: [{ type: "text", text: `PayPal API error: ${response.status} ${await response.text()}` }], isError: true };
        }

        const data = await response.json() as {
          transaction_details: Array<{
            transaction_info: {
              transaction_initiation_date: string;
              transaction_amount: { currency_code: string; value: string };
              transaction_status: string;
            };
            payer_info?: { payer_name?: { alternate_full_name?: string }; email_address?: string };
          }>;
        };

        // Filter to completed incoming payments (positive amounts)
        const incoming = data.transaction_details.filter(
          d => parseFloat(d.transaction_info.transaction_amount.value) > 0
        );

        const transactions = incoming.map(d => ({
          date: d.transaction_info.transaction_initiation_date,
          amount: parseFloat(d.transaction_info.transaction_amount.value),
          currency: d.transaction_info.transaction_amount.currency_code,
          from_name: d.payer_info?.payer_name?.alternate_full_name || "Unknown",
          from_email: d.payer_info?.email_address || null,
          status: d.transaction_info.transaction_status,
        }));

        const total = transactions.reduce((sum, t) => sum + t.amount, 0);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ total: Math.round(total * 100) / 100, count: transactions.length, transactions }, null, 2),
          }],
          isError: false,
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  // ─── paypal_send ─────────────────────────────────────────────────────────────

  server.tool(
    "paypal_send",
    "WARNING: Sends REAL money via PayPal. Double-check recipient and amount before calling.",
    {
      recipient_email: z.string().email().describe("Recipient's PayPal email address"),
      amount: z.number().positive().describe("Amount to send"),
      currency: z.string().default("USD").describe("Currency code (default USD)"),
      note: z.string().optional().describe("Optional note to include with payment"),
    },
    async ({ recipient_email, amount, currency, note }) => {
      try {
        const response = await paypalFetch("/v1/payments/payouts", {
          method: "POST",
          body: JSON.stringify({
            sender_batch_header: {
              sender_batch_id: `finance-mcp-${Date.now()}`,
              email_subject: note || "Payment",
              email_message: note || "You have received a payment.",
            },
            items: [{
              recipient_type: "EMAIL",
              amount: { value: amount.toFixed(2), currency },
              receiver: recipient_email,
              note: note || undefined,
            }],
          }),
        });

        if (!response.ok) {
          return { content: [{ type: "text", text: `PayPal API error: ${response.status} ${await response.text()}` }], isError: true };
        }

        const data = await response.json() as {
          batch_header: {
            payout_batch_id: string;
            batch_status: string;
            sender_batch_header: { sender_batch_id: string };
          };
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: data.batch_header.batch_status,
              payout_batch_id: data.batch_header.payout_batch_id,
              recipient: recipient_email,
              amount: amount.toFixed(2),
              currency,
              note: note || null,
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
