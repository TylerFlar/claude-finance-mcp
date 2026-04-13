export interface BankConfig {
  headless: boolean;
  browserDataDir: string;
  timeout: number;
}

export interface Balance {
  institution: string;
  account_name: string;
  type: "checking" | "credit";
  current_balance: number;
  available_balance: number | null;
  currency: string;
}

export interface Transaction {
  date: string;
  merchant: string;
  amount: number;
  category: string;
  account_name: string;
  pending: boolean;
}

export interface SpendingSummary {
  total_spent: number;
  total_income: number;
  net: number;
  by_category: Record<string, number>;
  by_account: Record<string, number>;
}

export interface CreditDueDate {
  institution: string;
  account_name: string;
  statement_balance: number | null;
  minimum_payment: number | null;
  due_date: string | null;
}

export interface RecurringCharge {
  merchant: string;
  amount: number;
  frequency: string;
  last_date: string;
  account_name: string;
}

export interface BankScrapeError {
  bank: string;
  error: string;
  sessionExpired: boolean;
}

export interface TransferResult {
  status: string;
  confirmation_number: string | null;
  from: string;
  to: string;
  amount: number;
}

export interface PaymentResult {
  status: string;
  confirmation_number: string | null;
  amount_paid: number;
  from?: string;
  card?: string;
}
