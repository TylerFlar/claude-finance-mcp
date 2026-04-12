# @tasque/finance-mcp

Unified finance MCP — bank accounts, credit cards, and PayPal.

## Tools

### Plaid (read-only — all linked accounts)

| Tool | Description |
|------|-------------|
| `get_balances` | Current balances across all linked accounts |
| `list_transactions` | Recent transactions with category, merchant, amount |
| `spending_summary` | Spending totals by category and account |
| `get_credit_due_dates` | Credit card statement balances and due dates |
| `get_recurring` | Detected recurring charges |

### PayPal (read + write)

| Tool | Description |
|------|-------------|
| `paypal_balance` | Current PayPal balance |
| `paypal_transactions` | Recent PayPal transactions |
| `paypal_commission_income` | Incoming payments (commission tracking) |
| `paypal_send` | Send money via PayPal |

### Bank actions (Playwright — write operations)

| Tool | Description |
|------|-------------|
| `sofi_transfer` | Transfer money from SoFi |
| `bofa_transfer` | Transfer between BofA accounts |
| `bofa_pay_credit_card` | Pay BofA credit card |
| `capitalone_pay` | Pay Capital One credit card |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLAID_CLIENT_ID` | Yes | Plaid API client ID |
| `PLAID_SECRET` | Yes | Plaid API secret |
| `PLAID_ENV` | No | sandbox/development/production (default: development) |
| `PAYPAL_CLIENT_ID` | Yes | PayPal REST API client ID |
| `PAYPAL_SECRET` | Yes | PayPal REST API secret |
| `PAYPAL_ENV` | No | sandbox/live (default: live) |
| `SOFI_USERNAME` | For transfers | SoFi login |
| `SOFI_PASSWORD` | For transfers | SoFi password |
| `BOFA_USERNAME` | For transfers/payments | BofA login |
| `BOFA_PASSWORD` | For transfers/payments | BofA password |
| `CAPITALONE_USERNAME` | For payments | Capital One login |
| `CAPITALONE_PASSWORD` | For payments | Capital One password |
| `TOKEN_DIR` | No | Plaid token storage (default: ~/.config/claude-finance-mcp) |
| `BROWSER_DATA_DIR` | No | Playwright session storage (default: ~/.config/claude-finance-mcp) |

## Auth Setup

### Plaid (bank account reads)
```bash
npm run setup:plaid   # Opens browser flow to link each bank
```

### PayPal
Set PAYPAL_CLIENT_ID and PAYPAL_SECRET env vars. No browser flow needed.

### Bank logins (for write operations)
```bash
node dist/scripts/setup-bank.js sofi
node dist/scripts/setup-bank.js bofa
node dist/scripts/setup-bank.js capitalone
```

## Development

```bash
npm install
npm run build
npm start           # stdio mode
```
