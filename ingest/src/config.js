import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

export async function loadBanksConfig(path = '/app/banks.yaml') {
  const text = await readFile(path, 'utf8');
  const parsed = YAML.parse(text);
  if (!parsed?.banks) throw new Error(`banks config at ${path} missing top-level 'banks' key`);
  return { banks: parsed.banks, owner: parsed.owner || { name_tokens: [] } };
}

export function accountNameFor(banksConfig, bank) {
  const cfg = banksConfig[bank];
  if (!cfg) throw new Error(`unknown bank: ${bank}`);
  if (!cfg.account_name) {
    throw new Error(`banks.yaml[${bank}].account_name is required`);
  }
  return cfg.account_name;
}

export function isSelfTransfer({ ownerTokens, payeeClean, description }) {
  if (!ownerTokens || ownerTokens.length === 0) return false;
  const haystack = `${payeeClean || ''} ${description || ''}`.toLowerCase();
  return ownerTokens.every((tok) => haystack.includes(String(tok).toLowerCase()));
}

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function interpolateEnv(config, env = process.env) {
  if (typeof config === 'string') {
    return config.replace(ENV_PATTERN, (_, name) => env[name] ?? `\${${name}}`);
  }
  if (Array.isArray(config)) return config.map((v) => interpolateEnv(v, env));
  if (config && typeof config === 'object') {
    return Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, interpolateEnv(v, env)]),
    );
  }
  return config;
}
