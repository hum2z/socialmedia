/**
 * stdio transports own stdout, so every diagnostic goes to stderr.
 * Enable with SOCIAL_MCP_DEBUG=1.
 */
const enabled = /^(1|true|yes)$/i.test(process.env.SOCIAL_MCP_DEBUG ?? "");

export function debug(...args: unknown[]): void {
  if (enabled) console.error("[social-mcp]", ...args);
}

export function warn(...args: unknown[]): void {
  console.error("[social-mcp][warn]", ...args);
}

/** Masks a secret for safe logging: keeps the first and last 4 chars. */
export function redact(secret: string | undefined): string {
  if (!secret) return "(unset)";
  if (secret.length <= 10) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
