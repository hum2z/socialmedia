import { resolveTargets } from "./config.js";
import { adapterFor } from "./platforms/index.js";
import { checkCapabilities } from "./platforms/base.js";
import type { AdapterContext } from "./platforms/base.js";
import type {
  Account,
  Config,
  PostContent,
  PublishResult,
  ValidationIssue,
} from "./types.js";
import { describeError } from "./util/errors.js";
import { debug } from "./util/logger.js";

/** One resolved target with its tailored content and its validation verdict. */
export interface PreparedTarget {
  account: Account;
  content: PostContent;
  issues: ValidationIssue[];
}

export function mergeContent(
  base: PostContent,
  override?: Partial<PostContent>,
): PostContent {
  if (!override) return base;
  return { ...base, ...override };
}

/** Generic capability checks plus the adapter's own rules. */
export function validateFor(
  account: Account,
  content: PostContent,
): ValidationIssue[] {
  const adapter = adapterFor(account.platform);
  return [
    ...checkCapabilities(adapter, content),
    ...(adapter.validate?.(content, account) ?? []),
  ];
}

/**
 * Expands selectors into accounts and applies per-platform then per-account
 * overrides, so the caller sees exactly what each account would receive.
 * Shared by the publish tool and the scheduler, so a scheduled post is
 * prepared identically to an immediate one.
 */
export function prepareTargets(
  config: Config,
  targets: string[],
  content: PostContent,
  overrides?: Record<string, Partial<PostContent>>,
): PreparedTarget[] {
  return resolveTargets(config, targets).map((account) => {
    const merged = mergeContent(
      mergeContent(content, overrides?.[account.platform]),
      overrides?.[account.id],
    );
    return { account, content: merged, issues: validateFor(account, merged) };
  });
}

export const errorsOf = (t: PreparedTarget) =>
  t.issues.filter((i) => i.level === "error");
export const warningsOf = (t: PreparedTarget) =>
  t.issues.filter((i) => i.level === "warning");

/**
 * Publishes to every prepared target. Targets are attempted independently:
 * one platform failing never prevents the others from going out.
 */
export async function executePublish(
  prepared: PreparedTarget[],
  ctx: AdapterContext,
  opts: { skipInvalid?: boolean } = {},
): Promise<PublishResult[]> {
  const results: PublishResult[] = [];

  for (const target of prepared) {
    const { account, content } = target;
    const errors = errorsOf(target);

    if (errors.length) {
      if (opts.skipInvalid === false) {
        throw new Error(
          `${account.id} failed validation: ${errors.map((e) => e.message).join("; ")}`,
        );
      }
      results.push({
        accountId: account.id,
        platform: account.platform,
        status: "failed",
        message: `Skipped — ${errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }

    try {
      debug(`publishing to ${account.id}`);
      const result = await adapterFor(account.platform).publish(ctx, account, content);
      const warnings = [
        ...(result.warnings ?? []),
        ...warningsOf(target).map((w) => w.message),
      ];
      results.push({ ...result, warnings: warnings.length ? warnings : undefined });
    } catch (err) {
      results.push({
        accountId: account.id,
        platform: account.platform,
        status: "failed",
        message: describeError(err),
      });
    }
  }

  return results;
}

/** Compact per-target view used by dry runs and by scheduled-job listings. */
export function describePlan(prepared: PreparedTarget[]) {
  return prepared.map((t) => ({
    accountId: t.account.id,
    platform: t.account.platform,
    handle: t.account.handle,
    title: t.content.topic,
    text: t.content.description,
    mediaCount: t.content.media?.length ?? 0,
    errors: errorsOf(t),
    warnings: warningsOf(t),
  }));
}
