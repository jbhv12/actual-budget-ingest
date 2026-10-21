import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export class PdfError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function decrypt(pdfPath, password, outPath) {
  try {
    await execFileP('qpdf', [`--password=${password}`, '--decrypt', pdfPath, outPath]);
  } catch (err) {
    if (/invalid password/i.test(err.stderr || '')) {
      throw new PdfError('wrong password', 'wrong-password');
    }
    throw new PdfError(`qpdf failed: ${err.stderr || err.message}`, 'qpdf-failed');
  }
}

export async function extractText(pdfBufferOrPath, { password } = {}) {
  const buf = Buffer.isBuffer(pdfBufferOrPath)
    ? pdfBufferOrPath
    : await readFile(pdfBufferOrPath);

  const tmpIn = path.join(tmpdir(), `${randomUUID()}.pdf`);
  const tmpOut = path.join(tmpdir(), `${randomUUID()}.pdf`);
  await writeFile(tmpIn, buf);

  try {
    if (password) {
      await decrypt(tmpIn, password, tmpOut);
    } else {
      await writeFile(tmpOut, buf);
    }
    const decrypted = await readFile(tmpOut);
    const parsed = await pdfParse(decrypted);
    return {
      text: parsed.text,
      numPages: parsed.numpages,
    };
  } finally {
    await Promise.allSettled([unlink(tmpIn), unlink(tmpOut)]);
  }
}
