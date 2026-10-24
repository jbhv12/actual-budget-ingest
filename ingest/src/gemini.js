import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const BUDGET_CATEGORIES = ['Food', 'General', 'Bills', 'Bills (Flexible)', 'Savings'];

const transactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  description: z.string().min(1),
  payee_clean: z.string().min(1),
  amount_paise: z.number().int(),
  balance_paise: z.number().int().nullable(),
  reference: z.string().nullable(),
  category: z.enum([...BUDGET_CATEGORIES, 'Unknown']),
});

const statementSchema = z.object({
  account_last4: z.string().regex(/^\d{4,20}$/, 'digits').transform((s) => s.slice(-4)),
  currency: z.literal('INR'),
  statement_period: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  opening_balance_paise: z.number().int(),
  closing_balance_paise: z.number().int(),
  transactions: z.array(transactionSchema),
});

export class GeminiError extends Error {
  constructor(message, code, raw) {
    super(message);
    this.code = code;
    this.raw = raw;
  }
}

function buildPrompt({ bankLabel, bankKind }) {
  const isCC = bankKind === 'credit_card';
  const signRule = isCC
    ? 'For a credit card statement: purchases/charges are NEGATIVE (money spent); payments/credits/refunds are POSITIVE.'
    : 'For a bank account: withdrawals/debits are NEGATIVE; deposits/credits are POSITIVE.';
  return `You are a precise parser of Indian bank and credit-card statements. The user will paste the raw text extracted from a ${bankLabel} statement PDF (kind: ${bankKind}).

Return a SINGLE JSON object (no markdown fence, no commentary) matching:

type Output = {
  account_last4: string;
  currency: "INR";
  statement_period: { from: string; to: string };
  opening_balance_paise: number;
  closing_balance_paise: number;
  transactions: Array<{
    date: string;
    description: string;
    payee_clean: string;
    amount_paise: number;
    balance_paise: number | null;
    reference: string | null;
    category: "Food" | "General" | "Bills" | "Bills (Flexible)" | "Savings" | "Unknown";
  }>;
};

Rules:
- Monetary values are paise (integer, INR * 100). ₹1,234.56 -> 123456.
- ${signRule}
- Dates ISO (YYYY-MM-DD).
- account_last4 is the trailing 4 digits of the account/card number shown on the statement header.
- balance_paise is the row's running balance when the statement shows one (typical for savings); set null when absent (typical for credit card statements).
- Return {"error": "<reason>"} if any required field is uncertain.
- No markdown fences in your response.

Category guide (pick exactly one per transaction). These match Actual Budget's
default category template:
- Food: groceries, restaurants, dining out, food delivery (Zomato, Swiggy),
  cafes, bars.
- General: non-essential shopping (clothes, gadgets, home decor), hobbies,
  gifts, entertainment, OTT subscriptions, travel for leisure, medical,
  pharmacy, vehicle service, bank fees, annual subscriptions, and anything
  else that is a real expense but not clearly Food/Bills/Savings.
- Bills: fixed monthly bills — rent, EMI, electricity, water, gas, mobile,
  internet, insurance renewals.
- Bills (Flexible): variable but recurring bills — fuel, commute, cabs/metro.
- Savings: SIPs, mutual funds, FD/RD, stock/broker transfers, PPF/EPF,
  retirement contributions, emergency-fund top-ups.
- Unknown: salary, interest credits, refunds, inter-account self-transfers,
  or any row where none of the above fits confidently.
`;
}

export async function parseStatement(text, { apiKey, model = 'gemini-2.5-flash', bankLabel = 'the configured bank', bankKind = 'savings' } = {}) {
  if (!apiKey) throw new GeminiError('missing GEMINI_API_KEY', 'no-api-key');

  const genAI = new GoogleGenerativeAI(apiKey);
  const client = genAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildPrompt({ bankLabel, bankKind });
  let resp;
  try {
    resp = await client.generateContent([{ text: prompt }, { text }]);
  } catch (err) {
    throw new GeminiError(`gemini API error: ${err.message}`, 'api-error');
  }

  const raw = resp.response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new GeminiError(`gemini returned invalid JSON: ${err.message}`, 'invalid-json', raw);
  }

  if (json.error) {
    throw new GeminiError(`gemini refused: ${json.error}`, 'parse-refused', json);
  }

  const result = statementSchema.safeParse(json);
  if (!result.success) {
    throw new GeminiError(
      `gemini output failed schema: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'schema-mismatch',
      json,
    );
  }
  return result.data;
}

export const _test = { statementSchema, transactionSchema, buildPrompt };
