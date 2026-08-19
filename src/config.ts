import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Account, Config, Platform } from "./types.js";
import { PLATFORMS } from "./types.js";
import { ConfigError } from "./util/errors.js";

/**
 * Resolution order for the account registry:
 *   1. $SOCIAL_MCP_CONFIG
 *   2. $XDG_CONFIG_HOME/social-mcp/accounts.json
 *   3. ~/.config/social-mcp/accounts.json
 */
export function configPath(): string {
  const explicit = process.env.SOCIAL_MCP_CONFIG;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "social-mcp", "accounts.json");
}

const EMPTY: Config = { version: 1, accounts: [] };

export async function loadConfig(): Promise<Config> {
  const file = configPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY);
    }
    throw new ConfigError(`Could not read ${file}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${file} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return normalizeConfig(parsed, file);
}

function normalizeConfig(parsed: unknown, file: string): Config {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError(`${file} must contain a JSON object.`);
  }
  const obj = parsed as Partial<Config>;
  const accounts = Array.isArray(obj.accounts) ? obj.accounts : [];
  const seen = new Set<string>();

  for (const account of accounts) {
    if (!account || typeof account !== "object") {
      throw new ConfigError(`${file}: every entry in "accounts" must be an object.`);
    }
    if (!account.id || typeof account.id !== "string") {
      throw new ConfigError(`${file}: every account needs a string "id".`);
    }
    if (seen.has(account.id)) {
      throw new ConfigError(`${file}: duplicate account id "${account.id}".`);
    }
    seen.add(account.id);
    if (!PLATFORMS.includes(account.platform as Platform)) {
      throw new ConfigError(
        `${file}: account "${account.id}" has unknown platform "${account.platform}". ` +
          `Expected one of: ${PLATFORMS.join(", ")}.`,
      );
    }
    if (!account.credentials || typeof account.credentials !== "object") {
      account.credentials = {};
    }
  }

  return {
    version: 1,
    accounts: accounts as Account[],
    defaults: obj.defaults ?? {},
  };
}

/** Writes the registry atomically with owner-only permissions. */
export async function saveConfig(config: Config): Promise<void> {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Resolves `env:VAR` indirection. A plain value is returned as-is, so the
 * registry can hold either a literal or a pointer to the environment.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4).trim();
  const found = process.env[name];
  if (found === undefined || found === "") return undefined;
  return found;
}

/** Reads one credential, resolving indirection. Throws when required and absent. */
export function credential(
  account: Account,
  key: string,
  opts: { required?: boolean } = {},
): string | undefined {
  const resolved = resolveSecret(account.credentials?.[key]);
  if (resolved === undefined && opts.required) {
    const declared = account.credentials?.[key];
    const hint = declared?.startsWith("env:")
      ? `Set the ${declared.slice(4)} environment variable.`
      : `Add "${key}" to the account's credentials in ${configPath()}.`;
    throw new ConfigError(
      `Account "${account.id}" is missing credential "${key}". ${hint}`,
    );
  }
  return resolved;
}

export function findAccount(config: Config, id: string): Account {
  const account = config.accounts.find((a) => a.id === id);
  if (!account) {
    const known = config.accounts.map((a) => a.id);
    throw new ConfigError(
      `No account with id "${id}". Known accounts: ${
        known.length ? known.join(", ") : "(none configured yet)"
      }.`,
    );
  }
  return account;
}

/**
 * Expands a target selector list into concrete accounts. Supports:
 *   - "all"                → every enabled account
 *   - "instagram"          → every enabled account on that platform
 *   - "tag:brand"          → every enabled account carrying that tag
 *   - "ig_main"            → that exact account (even if disabled)
 */
export function resolveTargets(config: Config, targets: string[]): Account[] {
  const out = new Map<string, Account>();
  const enabled = (a: Account) => a.enabled !== false;

  for (const raw of targets) {
    const selector = raw.trim();
    if (!selector) continue;

    if (selector === "all") {
      config.accounts.filter(enabled).forEach((a) => out.set(a.id, a));
      continue;
    }
    if (PLATFORMS.includes(selector as Platform)) {
      config.accounts
        .filter((a) => a.platform === selector && enabled(a))
        .forEach((a) => out.set(a.id, a));
      continue;
    }
    if (selector.startsWith("tag:")) {
      const tag = selector.slice(4);
      config.accounts
        .filter((a) => a.tags?.includes(tag) && enabled(a))
        .forEach((a) => out.set(a.id, a));
      continue;
    }
    out.set(selector, findAccount(config, selector));
  }

  if (out.size === 0) {
    throw new ConfigError(
      `Target list [${targets.join(", ")}] matched no accounts. ` +
        `Use "all", a platform name, "tag:<name>", or an account id from list_accounts.`,
    );
  }
  return [...out.values()];
}

/** Persists refreshed session tokens for one account without clobbering others. */
export async function updateSession(
  accountId: string,
  session: Account["session"],
): Promise<void> {
  const config = await loadConfig();
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) return;
  account.session = { ...account.session, ...session };
  await saveConfig(config);
}
