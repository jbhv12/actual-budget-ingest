import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

const transactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  description: z.string().min(1),
  payee_clean: z.string().min(1),
  amount_paise: z.number().int(),
  balance_paise: z.number().int().nullable(),
  reference: z.string().nullable(),
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

Return a SINGLE JSON object (no markdown fence, no commentary) matching this TypeScript type:

type Output = {
  account_last4: string;           // last 4 digits of the account number
  currency: "INR";                 // reject if any transaction is not INR
  statement_period: { from: string; to: string };  // YYYY-MM-DD, inclusive
  opening_balance_paise: number;   // integer; opening balance of the period
  closing_balance_paise: number;   // integer; closing balance of the period
  transactions: Array<{
    date: string;                  // YYYY-MM-DD
    description: string;           // raw narration from the statement, cleaned of excess whitespace
    payee_clean: string;           // short human-readable merchant name you have inferred (e.g. "Zomato", "Amazon India", "HDFC Credit Card Payment")
    amount_paise: number;          // integer; NEGATIVE for debits/withdrawals, POSITIVE for credits/deposits
    balance_paise: number | null;  // running balance if present on the row, else null
    reference: string | null;      // UPI ref, cheque number, or similar if present
  }>;
};

Hard rules:
- All monetary values are in paise (integer, INR * 100). ₹1,234.56 becomes 123456.
- Debits are NEGATIVE, credits are POSITIVE.
- Dates are ISO (YYYY-MM-DD).
- If you cannot determine any required field, do NOT guess. Return a JSON object with an "error" field explaining what is missing or malformed.
- Do NOT include markdown code fences in your response.
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
