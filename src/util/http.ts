import { ApiError } from "./errors.js";
import { debug } from "./logger.js";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Serialized as JSON unless `raw` or `form` is used. */
  body?: unknown;
  /** Sent verbatim (Buffer/stream chunk uploads). */
  raw?: Buffer | Uint8Array | string;
  /** Serialized as application/x-www-form-urlencoded. */
  form?: Record<string, string | undefined>;
  query?: Record<string, string | number | boolean | undefined>;
  platform: string;
  /** Total attempts for retryable failures. Default 3. */
  attempts?: number;
  timeoutMs?: number;
  /** Return the raw Response instead of parsed JSON. */
  rawResponse?: boolean;
}

const DEFAULT_TIMEOUT = 60_000;

function buildUrl(
  url: string,
  query?: RequestOptions["query"],
): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Honors Retry-After when present, otherwise exponential backoff with jitter. */
function backoffMs(attempt: number, res?: Response): number {
  const header = res?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 16_000);
  return base + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single entry point for every outbound platform call: adds timeouts, retries
 * on transient failures, and turns error bodies into actionable messages.
 */
export async function request<T = any>(
  url: string,
  opts: RequestOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const target = buildUrl(url, opts.query);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT,
    );

    try {
      const headers: Record<string, string> = { ...opts.headers };
      let payload: string | Uint8Array | undefined;

      if (opts.raw !== undefined) {
        payload = opts.raw;
      } else if (opts.form) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.form)) {
          if (v !== undefined) params.set(k, v);
        }
        payload = params.toString();
        headers["content-type"] ??= "application/x-www-form-urlencoded";
      } else if (opts.body !== undefined) {
        payload = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }

      debug(`${opts.method ?? "GET"} ${target.split("?")[0]}`);
      const res = await fetch(target, {
        method: opts.method ?? "GET",
        headers,
        body: payload as never,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = RETRYABLE_STATUS.has(res.status);
        if (retryable && attempt < attempts) {
          const wait = backoffMs(attempt, res);
          debug(`retrying after ${wait}ms (HTTP ${res.status})`);
          await sleep(wait);
          continue;
        }
        throw new ApiError(explain(opts.platform, res.status, text), {
          platform: opts.platform,
          status: res.status,
          code: extractCode(text),
          body: text.slice(0, 800),
          retryable,
        });
      }

      if (opts.rawResponse) return res as unknown as T;
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      lastError = err;
      const aborted = err instanceof Error && err.name === "AbortError";
      const network = err instanceof TypeError; // fetch throws TypeError on transport failure
      if ((aborted || network) && attempt < attempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (err instanceof ApiError) throw err;
      if (aborted) {
        throw new ApiError(
          `Request to ${opts.platform} timed out after ${
            opts.timeoutMs ?? DEFAULT_TIMEOUT
          }ms.`,
          { platform: opts.platform, retryable: true },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("request failed");
}

function extractCode(body: string): string | number | undefined {
  try {
    const parsed = JSON.parse(body);
    return (
      parsed?.error?.code ??
      parsed?.error?.error_subcode ??
      parsed?.error?.status ??
      parsed?.error_code ??
      parsed?.code ??
      parsed?.errors?.[0]?.code
    );
  } catch {
    return undefined;
  }
}

/** Turns a platform error body into a message that says what to actually do. */
function explain(platform: string, status: number, body: string): string {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    detail =
      parsed?.error?.message ??
      parsed?.error?.error_user_msg ??
      parsed?.error_description ??
      parsed?.error?.description ??
      parsed?.message ??
      parsed?.detail ??
      parsed?.errors?.[0]?.message ??
      parsed?.title ??
      detail;
  } catch {
    /* keep the raw excerpt */
  }

  const hints: Record<number, string> = {
    401: "The access token is invalid or expired — re-run check_account, or re-authorize the account.",
    403: "The token lacks the required scope, or the app is not approved for this endpoint.",
    404: "The object id does not exist, or this account cannot see it.",
    429: "Rate limited by the platform. Wait for the window to reset before retrying.",
  };
  const hint = hints[status];
  return `${platform}: ${detail}${hint ? ` — ${hint}` : ""}`;
}
