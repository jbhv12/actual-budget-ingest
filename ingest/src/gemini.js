import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const BUDGET_CATEGORIES = ['Essentials', 'Leisure', 'Investments', 'Maintenance'];

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
  account_last4: z.string().regex(/^\d{4}$/, '4 digits'),
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

const PROMPT = `You are a precise parser of Indian bank statements. The user will paste the raw text extracted from an HDFC Bank statement PDF.

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
    category: "Essentials" | "Leisure" | "Investments" | "Maintenance" | "Unknown";
  }>;
};

Rules:
- Monetary values are paise (integer, INR * 100). ₹1,234.56 -> 123456.
- Debits NEGATIVE, credits POSITIVE. Dates ISO (YYYY-MM-DD).
- Return "error": "<reason>" if any required field is uncertain.
- No markdown fences in your response.

Category guide (pick one per transaction):
- Essentials: groceries, utility bills, fuel, pharmacy, rent/EMI, mobile, internet,
  core food. Debit transactions required for daily life.
- Leisure: restaurants, dining out, OTT subscriptions, entertainment, travel for
  non-work, shopping for non-essentials, hobbies, gifts.
- Investments: SIPs, mutual-fund purchases, FD/RD, equity broker transfers,
  insurance premiums with investment component, PPF/EPF.
- Maintenance: home repairs, vehicle service, appliance repair, medical check-ups,
  cleaning/pest services, bank fees, govt filings.
- Unknown: credits/refunds, inter-account transfers, salary, interest, or any
  transaction where none of the four categories clearly fits.
`;

export async function parseStatement(text, { apiKey, model = 'gemini-2.5-flash' } = {}) {
  if (!apiKey) throw new GeminiError('missing GEMINI_API_KEY', 'no-api-key');

  const genAI = new GoogleGenerativeAI(apiKey);
  const client = genAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  });

  let resp;
  try {
    resp = await client.generateContent([{ text: PROMPT }, { text }]);
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

export const _test = { statementSchema, transactionSchema, PROMPT };
