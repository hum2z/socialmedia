import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  configPath,
  findAccount,
  loadConfig,
  resolveTargets,
  saveConfig,
  updateSession,
} from "./config.js";
import { adapterFor, ADAPTERS } from "./platforms/index.js";
import { checkCapabilities, defaultRange } from "./platforms/base.js";
import type { AdapterContext } from "./platforms/base.js";
import { PLATFORMS } from "./types.js";
import type {
  Account,
  Platform,
  PostContent,
  PublishResult,
  ValidationIssue,
} from "./types.js";
import { describeError } from "./util/errors.js";
import { debug } from "./util/logger.js";

const ctx: AdapterContext = {
  saveSession: (accountId, session) => updateSession(accountId, session),
};

/** Every tool returns text; JSON keeps it parseable while staying readable. */
function reply(payload: unknown, summary?: string) {
  const body = JSON.stringify(payload, null, 2);
  return {
    content: [
      { type: "text" as const, text: summary ? `${summary}\n\n${body}` : body },
    ],
  };
}

function failure(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${describeError(err)}` }],
  };
}

const mediaSchema = z.object({
  kind: z.enum(["image", "video"]).describe("Whether this item is an image or a video."),
  url: z
    .string()
    .optional()
    .describe("Publicly reachable URL. Required for Instagram and TikTok photo posts."),
  path: z
    .string()
    .optional()
    .describe("Local file path. Used by YouTube, X, LinkedIn and TikTok video uploads."),
  altText: z.string().optional().describe("Accessibility text, where the platform supports it."),
  thumbnailPath: z.string().optional().describe("Local custom thumbnail (YouTube)."),
});

const contentSchema = z.object({
  topic: z
    .string()
    .optional()
    .describe("Short headline. Becomes the YouTube title and leads the caption elsewhere."),
  description: z
    .string()
    .optional()
    .describe("Main body text: the caption, description or post text."),
  hashtags: z
    .array(z.string())
    .optional()
    .describe("Hashtags without the leading '#'. Appended per platform convention."),
  media: z.array(mediaSchema).optional(),
  firstComment: z
    .string()
    .optional()
    .describe("Posted as a comment right after the post lands, where supported."),
  thread: z
    .array(z.string())
    .optional()
    .describe("Extra posts chained under the first one (X only)."),
  privacy: z.enum(["public", "private", "unlisted"]).optional(),
  scheduledAt: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp. Only YouTube schedules natively."),
  platformOverrides: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional()
    .describe("Raw per-platform request fields, merged into the outgoing body."),
});

const targetsSchema = z
  .array(z.string())
  .describe(
    'Account selectors: an account id ("ig_main"), a platform ("instagram"), "tag:<name>", or "all".',
  );

function mergeContent(base: PostContent, override?: Partial<PostContent>): PostContent {
  if (!override) return base;
  return { ...base, ...override };
}

/** Collects generic capability checks plus the adapter's own rules. */
function validateFor(account: Account, content: PostContent): ValidationIssue[] {
  const adapter = adapterFor(account.platform);
  return [
    ...checkCapabilities(adapter, content),
    ...(adapter.validate?.(content, account) ?? []),
  ];
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "social-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_accounts",
    {
      title: "List connected accounts",
      description:
        "Lists every configured social account with its platform, handle, tags and capabilities. " +
        "Start here to learn which account ids exist before publishing or pulling analytics.",
      inputSchema: {
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Restrict the listing to one platform."),
      },
    },
    async ({ platform }) => {
      try {
        const config = await loadConfig();
        const accounts = config.accounts
          .filter((a) => !platform || a.platform === platform)
          .map((a) => ({
            id: a.id,
            platform: a.platform,
            label: a.label,
            handle: a.handle,
            tags: a.tags ?? [],
            enabled: a.enabled !== false,
            capabilities: adapterFor(a.platform).capabilities,
          }));

        return reply(
          {
            configFile: configPath(),
            accountCount: accounts.length,
            accounts,
            defaultTargets: config.defaults?.targets ?? [],
          },
          accounts.length
            ? `${accounts.length} account(s) configured.`
            : `No accounts configured yet. Add them with add_account, or edit ${configPath()}.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "check_account",
    {
      title: "Verify account credentials",
      description:
        "Calls each account's profile endpoint to confirm the credentials work, refreshing " +
        "access tokens as needed. Returns follower counts and any remaining publish quota. " +
        "Run this before a posting session to catch expired tokens early.",
      inputSchema: {
        targets: targetsSchema.optional().describe('Defaults to "all".'),
      },
    },
    async ({ targets }) => {
      try {
        const config = await loadConfig();
        const accounts = resolveTargets(config, targets ?? ["all"]);
        const results = await Promise.all(
          accounts.map(async (account) => {
            try {
              const profile = await adapterFor(account.platform).verify(ctx, account);
              return { ...profile, ok: true };
            } catch (err) {
              return {
                accountId: account.id,
                platform: account.platform,
                ok: false,
                error: describeError(err),
              };
            }
          }),
        );
        const healthy = results.filter((r) => r.ok).length;
        return reply(
          { checked: results.length, healthy, results },
          `${healthy}/${results.length} account(s) authenticated successfully.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "preview_post",
    {
      title: "Dry-run a post across accounts",
      description:
        "Shows exactly what each target account would receive — the rendered caption, the " +
        "media, and any validation errors or warnings — without publishing anything. " +
        "Use this to check character limits and media rules before calling publish.",
      inputSchema: {
        targets: targetsSchema,
        content: contentSchema,
        overrides: z
          .record(z.string(), contentSchema.partial())
          .optional()
          .describe("Per-account or per-platform content overrides, keyed by id or platform name."),
      },
    },
    async ({ targets, content, overrides }) => {
      try {
        const config = await loadConfig();
        const accounts = resolveTargets(config, targets);
        const plan = accounts.map((account) => {
          const merged = mergeContent(
            mergeContent(content as PostContent, overrides?.[account.platform]),
            overrides?.[account.id],
          );
          const issues = validateFor(account, merged);
          return {
            accountId: account.id,
            platform: account.platform,
            handle: account.handle,
            wouldPost: {
              title: merged.topic,
              text: merged.description,
              hashtags: merged.hashtags ?? [],
              mediaCount: merged.media?.length ?? 0,
              firstComment: merged.firstComment,
              threadLength: merged.thread?.length ?? 0,
              privacy: merged.privacy ?? "public",
              scheduledAt: merged.scheduledAt,
            },
            errors: issues.filter((i) => i.level === "error"),
            warnings: issues.filter((i) => i.level === "warning"),
          };
        });

        const blocking = plan.filter((p) => p.errors.length);
        return reply(
          { targets: plan.length, plan },
          blocking.length
            ? `${blocking.length} of ${plan.length} target(s) would fail validation: ${blocking
                .map((b) => b.accountId)
                .join(", ")}.`
            : `All ${plan.length} target(s) pass validation. Call publish with confirm: true to post.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "publish",
    {
      title: "Publish to one or many accounts",
      description:
        "Publishes the same content to every target account, adapting it to each platform's " +
        "limits. Requires confirm: true — without it this returns the dry-run plan instead of " +
        "posting, so a caller can never publish by accident. Targets are attempted independently: " +
        "one platform failing does not stop the others. TikTok and Instagram video finish " +
        "asynchronously and return a jobRef for get_publish_status.",
      inputSchema: {
        targets: targetsSchema,
        content: contentSchema,
        overrides: z
          .record(z.string(), contentSchema.partial())
          .optional()
          .describe("Per-account or per-platform content overrides, keyed by id or platform name."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Must be true to actually post. False returns the plan without publishing."),
        skipInvalid: z
          .boolean()
          .default(true)
          .describe("Skip targets that fail validation instead of failing the whole call."),
      },
    },
    async ({ targets, content, overrides, confirm, skipInvalid }) => {
      try {
        const config = await loadConfig();
        const accounts = resolveTargets(config, targets);

        const prepared = accounts.map((account) => {
          const merged = mergeContent(
            mergeContent(content as PostContent, overrides?.[account.platform]),
            overrides?.[account.id],
          );
          return { account, content: merged, issues: validateFor(account, merged) };
        });

        if (!confirm) {
          return reply(
            {
              published: false,
              reason: "confirm was not true — nothing was posted.",
              plan: prepared.map((p) => ({
                accountId: p.account.id,
                platform: p.account.platform,
                handle: p.account.handle,
                title: p.content.topic,
                text: p.content.description,
                mediaCount: p.content.media?.length ?? 0,
                errors: p.issues.filter((i) => i.level === "error"),
                warnings: p.issues.filter((i) => i.level === "warning"),
              })),
            },
            `Dry run for ${prepared.length} target(s). Re-send with confirm: true to publish.`,
          );
        }

        const results: PublishResult[] = [];
        for (const { account, content: merged, issues } of prepared) {
          const errors = issues.filter((i) => i.level === "error");
          if (errors.length) {
            if (!skipInvalid) {
              return failure(
                new Error(
                  `${account.id} failed validation: ${errors.map((e) => e.message).join("; ")}`,
                ),
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
            const result = await adapterFor(account.platform).publish(ctx, account, merged);
            const warnings = issues.filter((i) => i.level === "warning").map((w) => w.message);
            results.push({
              ...result,
              warnings: [...(result.warnings ?? []), ...warnings].length
                ? [...(result.warnings ?? []), ...warnings]
                : undefined,
            });
          } catch (err) {
            // One platform's failure must never abort the rest of the fan-out.
            results.push({
              accountId: account.id,
              platform: account.platform,
              status: "failed",
              message: describeError(err),
            });
          }
        }

        const ok = results.filter((r) => r.status === "published" || r.status === "scheduled");
        const pending = results.filter((r) => r.status === "processing");
        const failed = results.filter((r) => r.status === "failed");

        const summary = [
          `${ok.length} published`,
          pending.length ? `${pending.length} still processing` : "",
          failed.length ? `${failed.length} failed` : "",
        ]
          .filter(Boolean)
          .join(", ");

        return reply({ published: true, results }, summary + ".");
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_publish_status",
    {
      title: "Check an asynchronous publish",
      description:
        "Polls a pending publish returned by the publish tool. TikTok always finishes " +
        "asynchronously; Instagram video does when transcoding runs long. Pass the accountId " +
        "and the jobRef from the publish result.",
      inputSchema: {
        accountId: z.string(),
        jobRef: z.string().describe("The jobRef from the publish result."),
      },
    },
    async ({ accountId, jobRef }) => {
      try {
        const config = await loadConfig();
        const account = findAccount(config, accountId);
        const adapter = adapterFor(account.platform);
        if (!adapter.publishStatus) {
          return failure(
            new Error(`${account.platform} publishes synchronously; there is no job to poll.`),
          );
        }
        const result = await adapter.publishStatus(ctx, account, jobRef);
        return reply(result, `Status: ${result.status}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "account_analytics",
    {
      title: "Account-level analytics",
      description:
        "Pulls follower, reach and engagement metrics for one or many accounts over a date " +
        "range (defaults to the trailing 28 days), so numbers can be compared across platforms " +
        "in one call. Platforms differ in what they expose — anything unavailable is explained " +
        "in the notes rather than silently dropped.",
      inputSchema: {
        targets: targetsSchema.optional().describe('Defaults to "all".'),
        since: z.string().optional().describe("YYYY-MM-DD. Defaults to 27 days before `until`."),
        until: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
      },
    },
    async ({ targets, since, until }) => {
      try {
        const config = await loadConfig();
        const accounts = resolveTargets(config, targets ?? ["all"]);
        const range = defaultRange({ since, until });

        const results = await Promise.all(
          accounts.map(async (account) => {
            try {
              return await adapterFor(account.platform).accountAnalytics(ctx, account, range);
            } catch (err) {
              return {
                accountId: account.id,
                platform: account.platform,
                range,
                totals: {},
                notes: [`Failed: ${describeError(err)}`],
              };
            }
          }),
        );

        return reply({ range, accounts: results }, `Analytics for ${results.length} account(s), ${range.since} → ${range.until}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "post_analytics",
    {
      title: "Per-post analytics",
      description:
        "Fetches metrics for a single published post: views, likes, comments, shares, saves and " +
        "whatever else the platform exposes for that media type.",
      inputSchema: {
        accountId: z.string(),
        postId: z.string().describe("The platform's post/media/video id, as returned by publish or list_posts."),
      },
    },
    async ({ accountId, postId }) => {
      try {
        const config = await loadConfig();
        const account = findAccount(config, accountId);
        const result = await adapterFor(account.platform).postAnalytics(ctx, account, postId);
        return reply(result);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_posts",
    {
      title: "List recent posts",
      description:
        "Returns recent posts for the given accounts with their headline metrics — the fastest " +
        "way to find a postId, or to compare how recent content performed across accounts.",
      inputSchema: {
        targets: targetsSchema.optional().describe('Defaults to "all".'),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ targets, limit }) => {
      try {
        const config = await loadConfig();
        const accounts = resolveTargets(config, targets ?? ["all"]);
        const results = await Promise.all(
          accounts.map(async (account) => {
            try {
              const posts = await adapterFor(account.platform).listPosts(ctx, account, limit);
              return { accountId: account.id, platform: account.platform, posts };
            } catch (err) {
              return {
                accountId: account.id,
                platform: account.platform,
                posts: [],
                error: describeError(err),
              };
            }
          }),
        );
        return reply({ accounts: results });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_comments",
    {
      title: "Read comments on a post",
      description:
        "Lists comments on a post so they can be triaged or answered. Note that TikTok's public " +
        "API does not expose comments at all — that call returns a clear explanation instead.",
      inputSchema: {
        accountId: z.string(),
        postId: z.string(),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ accountId, postId, limit }) => {
      try {
        const config = await loadConfig();
        const account = findAccount(config, accountId);
        const comments = await adapterFor(account.platform).listComments(
          ctx,
          account,
          postId,
          limit,
        );
        return reply(
          { accountId, postId, count: comments.length, comments },
          `${comments.length} comment(s).`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Comment or reply publicly",
      description:
        "Posts a public comment on your own post, or a reply under an existing comment. " +
        "Requires confirm: true because this is immediately visible to the audience.",
      inputSchema: {
        accountId: z.string(),
        text: z.string().describe("The comment body."),
        commentId: z.string().optional().describe("Reply under this comment."),
        postId: z.string().optional().describe("Comment on this post when commentId is omitted."),
        confirm: z.boolean().default(false).describe("Must be true to actually post."),
      },
    },
    async ({ accountId, text, commentId, postId, confirm }) => {
      try {
        const config = await loadConfig();
        const account = findAccount(config, accountId);
        const adapter = adapterFor(account.platform);
        if (!adapter.replyToComment) {
          return failure(
            new Error(`${account.platform} does not support commenting through its API.`),
          );
        }
        if (!confirm) {
          return reply(
            { posted: false, wouldPost: { accountId, commentId, postId, text } },
            "Dry run — re-send with confirm: true to post this comment publicly.",
          );
        }
        const result = await adapter.replyToComment(ctx, account, { commentId, postId, text });
        return reply({ posted: true, ...result }, "Comment posted.");
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a published post",
      description:
        "Permanently removes a post. This cannot be undone, so it requires confirm: true. " +
        "Instagram and TikTok do not allow deletion through their APIs.",
      inputSchema: {
        accountId: z.string(),
        postId: z.string(),
        confirm: z.boolean().default(false).describe("Must be true. Deletion is irreversible."),
      },
    },
    async ({ accountId, postId, confirm }) => {
      try {
        const config = await loadConfig();
        const account = findAccount(config, accountId);
        const adapter = adapterFor(account.platform);
        if (!adapter.deletePost) {
          return failure(
            new Error(
              `${account.platform} does not allow deleting posts through its API — remove it in the app instead.`,
            ),
          );
        }
        if (!confirm) {
          return reply(
            { deleted: false, wouldDelete: { accountId, postId } },
            "Dry run — deletion is permanent. Re-send with confirm: true.",
          );
        }
        await adapter.deletePost(ctx, account, postId);
        return reply({ deleted: true, accountId, postId }, "Post deleted.");
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "add_account",
    {
      title: "Register an account",
      description:
        "Adds or updates an account in the local registry. Credential values may use " +
        '"env:VAR_NAME" so the secret itself lives in the environment rather than on disk. ' +
        "Run check_account afterwards to confirm the credentials work.",
      inputSchema: {
        id: z.string().describe('Stable short id used as the target selector, e.g. "ig_main".'),
        platform: z.enum(PLATFORMS),
        label: z.string().optional(),
        handle: z.string().optional(),
        tags: z.array(z.string()).optional(),
        credentials: z
          .record(z.string(), z.string())
          .describe(
            "Platform credentials. instagram: igUserId, accessToken. youtube: clientId, " +
              "clientSecret, refreshToken. tiktok: clientKey, clientSecret, refreshToken. " +
              "x: clientId, clientSecret, refreshToken. linkedin: accessToken, authorUrn.",
          ),
        enabled: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const config = await loadConfig();
        const existing = config.accounts.findIndex((a) => a.id === args.id);
        const account: Account = {
          id: args.id,
          platform: args.platform as Platform,
          label: args.label,
          handle: args.handle,
          tags: args.tags,
          credentials: args.credentials,
          enabled: args.enabled ?? true,
        };
        if (existing >= 0) {
          // Preserve any cached session so an update does not force a re-auth.
          account.session = config.accounts[existing]!.session;
          config.accounts[existing] = account;
        } else {
          config.accounts.push(account);
        }
        await saveConfig(config);
        return reply(
          { saved: account.id, configFile: configPath(), totalAccounts: config.accounts.length },
          `${existing >= 0 ? "Updated" : "Added"} "${account.id}". Run check_account to verify it.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "remove_account",
    {
      title: "Remove an account",
      description: "Deletes an account from the local registry. Does not touch the platform itself.",
      inputSchema: {
        id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ id, confirm }) => {
      try {
        const config = await loadConfig();
        findAccount(config, id);
        if (!confirm) {
          return reply({ removed: false, id }, "Dry run — re-send with confirm: true.");
        }
        config.accounts = config.accounts.filter((a) => a.id !== id);
        await saveConfig(config);
        return reply({ removed: true, id, remaining: config.accounts.length });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "platform_capabilities",
    {
      title: "What each platform supports",
      description:
        "Returns the hard limits and supported features for every platform this server can " +
        "reach: caption lengths, media rules, threading, scheduling, deletion and comment support. " +
        "Consult this when tailoring one piece of content for several platforms at once.",
      inputSchema: {
        platform: z.enum(PLATFORMS).optional(),
      },
    },
    async ({ platform }) => {
      const entries = Object.entries(ADAPTERS)
        .filter(([name]) => !platform || name === platform)
        .map(([name, adapter]) => ({ platform: name, ...adapter.capabilities }));
      return reply({ platforms: entries });
    },
  );

  return server;
}
