import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { PlaidTokenEntry } from "../types.js";

const DEFAULT_TOKEN_DIR = path.join(os.homedir(), ".config", "claude-finance-mcp");

function getTokenDir(): string {
  return process.env.TOKEN_DIR || DEFAULT_TOKEN_DIR;
}

function getTokenPath(): string {
  return path.join(getTokenDir(), "plaid-tokens.json");
}

export function getPlaidClient(): PlaidApi {
  const env = process.env.PLAID_ENV || "development";
  const basePath = env === "production"
    ? PlaidEnvironments.production
    : env === "development"
      ? PlaidEnvironments.development
      : PlaidEnvironments.sandbox;

  const configuration = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
        "PLAID-SECRET": process.env.PLAID_SECRET || "",
      },
    },
  });

  return new PlaidApi(configuration);
}

export function loadTokens(): PlaidTokenEntry[] {
  const tokenPath = getTokenPath();
  try {
    const data = fs.readFileSync(tokenPath, "utf-8");
    return JSON.parse(data) as PlaidTokenEntry[];
  } catch {
    return [];
  }
}

export function saveTokens(tokens: PlaidTokenEntry[]): void {
  const tokenDir = getTokenDir();
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(getTokenPath(), JSON.stringify(tokens, null, 2));
}
