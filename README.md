# @tasque/finance-mcp

Unified finance MCP — bank accounts, credit cards, and PayPal. All bank operations use Playwright browser automation.

## Tools

### Aggregate (read — all banks via Playwright)

| Tool | Description |
|------|-------------|
| `get_balances` | Current balances across all banks (SoFi, BofA, Capital One) |
| `list_transactions` | Recent transactions with merchant, amount, date |
| `spending_summary` | Spending totals by category and account |
| `get_credit_due_dates` | Credit card statement balances and due dates |
| `get_recurring` | Detected recurring charges (heuristic pattern matching) |

### Per-bank read tools (Playwright)

| Tool | Description |
|------|-------------|
| `sofi_balances` | SoFi checking/savings balances |
| `sofi_transactions` | SoFi recent transactions |
| `bofa_balances` | BofA checking and credit card balances |
| `bofa_transactions` | BofA recent transactions |
| `bofa_credit_due_date` | BofA credit card due date and payment info |
| `capitalone_balances` | Capital One credit card balance |
| `capitalone_transactions` | Capital One recent transactions |
| `capitalone_credit_due_date` | Capital One due date and payment info |

### Per-bank write tools (Playwright)

| Tool | Description |
|------|-------------|
| `sofi_transfer` | Transfer money from SoFi |
| `bofa_transfer` | Transfer between BofA accounts |
| `bofa_pay_credit_card` | Pay BofA credit card |
| `capitalone_pay` | Pay Capital One credit card |

### PayPal (read + write — REST API)

| Tool | Description |
|------|-------------|
| `paypal_balance` | Current PayPal balance |
| `paypal_transactions` | Recent PayPal transactions |
| `paypal_commission_income` | Incoming payments (commission tracking) |
| `paypal_send` | Send money via PayPal |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYPAL_CLIENT_ID` | Yes | PayPal REST API client ID |
| `PAYPAL_SECRET` | Yes | PayPal REST API secret |
| `PAYPAL_ENV` | No | sandbox/live (default: live) |
| `SOFI_USERNAME` | For SoFi | SoFi login |
| `SOFI_PASSWORD` | For SoFi | SoFi password |
| `BOFA_USERNAME` | For BofA | BofA login |
| `BOFA_PASSWORD` | For BofA | BofA password |
| `CAPITALONE_USERNAME` | For Capital One | Capital One login |
| `CAPITALONE_PASSWORD` | For Capital One | Capital One password |
| `BROWSER_DATA_DIR` | No | Playwright session storage (default: ~/.config/claude-finance-mcp) |
| `HEADLESS` | No | Run browser headless (default: true) |

## Auth Setup

### Bank logins (all read + write operations)
```bash
node dist/scripts/setup-bank.js sofi
node dist/scripts/setup-bank.js bofa
node dist/scripts/setup-bank.js capitalone
```
Sessions are stored as cookies in `BROWSER_DATA_DIR`. Re-run setup when sessions expire.

### PayPal
Set PAYPAL_CLIENT_ID and PAYPAL_SECRET env vars. No browser flow needed.

## Development

```bash
npm install
npm run build
npm start           # stdio mode
```
