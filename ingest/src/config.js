import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

export async function loadBanksConfig(path = '/app/banks.yaml') {
  const text = await readFile(path, 'utf8');
  const parsed = YAML.parse(text);
  if (!parsed?.banks) throw new Error(`banks config at ${path} missing top-level 'banks' key`);
  return parsed.banks;
}

export function resolveAccount(banksConfig, bank, account_last4) {
  const cfg = banksConfig[bank];
  if (!cfg) throw new Error(`unknown bank: ${bank}`);
  const acct = (cfg.accounts || []).find((a) => a.last4 === account_last4);
  if (!acct) {
    throw new Error(
      `no mapping for ${bank} account ending ${account_last4}; add it to banks.yaml`,
    );
  }
  const id = String(acct.actual_account_id || '');
  if (!id || id.startsWith('REPLACE_ME') || id.startsWith('${')) {
    throw new Error(
      `${bank}:${account_last4} is mapped to a placeholder; fill in actual_account_id in banks.yaml or export the matching env var`,
    );
  }
  return id;
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
