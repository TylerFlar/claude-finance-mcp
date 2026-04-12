import http from "http";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { loadTokens, saveTokens } from "../plaid/client.js";
import * as readline from "readline";

const PORT = 9878;

function getPlaidClient(): PlaidApi {
  const env = process.env.PLAID_ENV || "development";
  const basePath = env === "production"
    ? PlaidEnvironments.production
    : env === "development"
      ? PlaidEnvironments.development
      : PlaidEnvironments.sandbox;

  return new PlaidApi(new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
        "PLAID-SECRET": process.env.PLAID_SECRET || "",
      },
    },
  }));
}

async function createLinkToken(client: PlaidApi): Promise<string> {
  const response = await client.linkTokenCreate({
    user: { client_user_id: "finance-mcp-user" },
    client_name: "Finance MCP",
    products: [Products.Transactions, Products.Liabilities],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

function serveLinkPage(linkToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${PORT}`);

      if (url.pathname === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const data = JSON.parse(body) as { public_token: string; metadata: { institution: { name: string } } };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          server.close();
          resolve(data.public_token + "|" + data.metadata.institution.name);
        });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><title>Connect Bank — Finance MCP</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head><body>
<h1>Finance MCP — Connect Bank Account</h1>
<p id="status">Initializing Plaid Link...</p>
<script>
const handler = Plaid.create({
  token: '${linkToken}',
  onSuccess: async (public_token, metadata) => {
    document.getElementById('status').textContent = 'Connecting ' + metadata.institution.name + '...';
    await fetch('/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token, metadata }),
    });
    document.getElementById('status').textContent = metadata.institution.name + ' connected! You can close this tab.';
  },
  onExit: (err) => {
    if (err) document.getElementById('status').textContent = 'Error: ' + err.display_message;
    else document.getElementById('status').textContent = 'Link closed. Refresh to retry.';
  },
});
handler.open();
</script>
</body></html>`);
    });

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`\nOpen http://localhost:${PORT} in your browser to connect a bank.\n`);
    });

    server.on("error", reject);
  });
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const client = getPlaidClient();
  const tokens = loadTokens();

  console.log("=== Plaid Link Setup ===");
  console.log(`Currently linked: ${tokens.length} institution(s)`);
  if (tokens.length > 0) {
    tokens.forEach(t => console.log(`  - ${t.institution}`));
  }

  let continueSetup = true;
  while (continueSetup) {
    console.log("\nCreating Plaid Link token...");
    const linkToken = await createLinkToken(client);

    const result = await serveLinkPage(linkToken);
    const [publicToken, institutionName] = result.split("|");

    console.log(`\nExchanging token for ${institutionName}...`);
    const exchangeResponse = await client.itemPublicTokenExchange({ public_token: publicToken });

    tokens.push({
      access_token: exchangeResponse.data.access_token,
      institution: institutionName,
      item_id: exchangeResponse.data.item_id,
    });
    saveTokens(tokens);
    console.log(`${institutionName} linked successfully!`);

    const answer = await ask("\nConnect another bank? [y/N] ");
    continueSetup = /^y/i.test(answer);
  }

  console.log(`\nDone. ${tokens.length} institution(s) linked.`);
}

main().catch(err => { console.error(err); process.exit(1); });
