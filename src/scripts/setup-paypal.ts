import { getAccessToken } from "../paypal/client.js";

async function main() {
  console.log("=== PayPal Credential Verification ===\n");

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const env = process.env.PAYPAL_ENV || "live";

  if (!clientId || !secret) {
    console.error("Error: PAYPAL_CLIENT_ID and PAYPAL_SECRET must be set.");
    process.exit(1);
  }

  console.log(`Environment: ${env}`);
  console.log(`Client ID: ${clientId.slice(0, 8)}...`);
  console.log("Fetching OAuth token...\n");

  try {
    const token = await getAccessToken();
    console.log(`Success! Token: ${token.slice(0, 12)}...`);
    console.log("PayPal credentials are valid.");
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
