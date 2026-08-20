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
import { defaultRange } from "./platforms/base.js";
import type { AdapterContext } from "./platforms/base.js";
import {
  describePlan,
  errorsOf,
  executePublish,
  prepareTargets,
  warningsOf,
} from "./publish.js";
import { runDueJobs } from "./scheduler/runner.js";
import {
  dueAt,
  isTerminal,
  newJob,
  saveQueue,
  withQueueLock,
  queuePath,
  type ScheduledJob,
} from "./scheduler/store.js";
import { relativeToNow, resolveWhen } from "./scheduler/time.js";
import { PLATFORMS } from "./types.js";
import type { Account, Platform, PostContent } from "./types.js";
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
        const plan = prepareTargets(
          config,
          targets,
          content as PostContent,
          overrides,
        ).map((t) => ({
          accountId: t.account.id,
          platform: t.account.platform,
          handle: t.account.handle,
          wouldPost: {
            title: t.content.topic,
            text: t.content.description,
            hashtags: t.content.hashtags ?? [],
            mediaCount: t.content.media?.length ?? 0,
            firstComment: t.content.firstComment,
            threadLength: t.content.thread?.length ?? 0,
            privacy: t.content.privacy ?? "public",
            scheduledAt: t.content.scheduledAt,
          },
          errors: errorsOf(t),
          warnings: warningsOf(t),
        }));

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
        const prepared = prepareTargets(
          config,
          targets,
          content as PostContent,
          overrides,
        );

        if (!confirm) {
          return reply(
            {
              published: false,
              reason: "confirm was not true — nothing was posted.",
              plan: describePlan(prepared),
            },
            `Dry run for ${prepared.length} target(s). Re-send with confirm: true to publish.`,
          );
        }

        const results = await executePublish(prepared, ctx, { skipInvalid });

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
    "schedule_post",
    {
      title: "Schedule a post for later",
      description:
        "Queues a post to go out at a future time, to any set of accounts. Requires " +
        "confirm: true, because it commits to publishing unattended. IMPORTANT: something " +
        "must be running at the scheduled moment for it to fire — either this MCP server " +
        "(which ticks while connected) or `social-mcp --worker` running in the background. " +
        "A job whose time passes with nothing running is marked 'missed' rather than posted " +
        "hours late. Validation runs now, at scheduling time, so problems surface immediately " +
        "instead of silently at 3am.",
      inputSchema: {
        targets: targetsSchema,
        content: contentSchema,
        overrides: z
          .record(z.string(), contentSchema.partial())
          .optional()
          .describe("Per-account or per-platform content overrides."),
        scheduledFor: z
          .string()
          .describe(
            'When to post. An ISO-8601 timestamp with an offset ("2026-09-01T15:00:00Z"), ' +
              'a wall-clock time paired with `timezone` ("2026-09-01 15:00"), ' +
              'or a relative offset ("+2h", "+30m", "+3d").',
          ),
        timezone: z
          .string()
          .optional()
          .describe('IANA zone for a bare wall-clock time, e.g. "Europe/Berlin".'),
        repeat: z
          .object({
            every: z.enum(["hour", "day", "week"]),
            interval: z.number().int().min(1).default(1).describe("Fire every N units."),
            count: z
              .number()
              .int()
              .min(2)
              .max(365)
              .describe("Total number of runs, including the first. Required — a repeat cannot be open-ended."),
          })
          .optional()
          .describe("Optional recurrence. Bounded by `count` so it can never run away."),
        note: z.string().optional().describe("A reminder to yourself, shown in listings."),
        maxAttempts: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Retries if every target fails. Backs off 5, 10, 20 minutes."),
        confirm: z.boolean().default(false).describe("Must be true to actually schedule."),
      },
    },
    async ({ targets, content, overrides, scheduledFor, timezone, repeat, note, maxAttempts, confirm }) => {
      try {
        const when = resolveWhen(scheduledFor, timezone);
        if (Date.parse(when.iso) <= Date.now()) {
          return failure(
            new Error(
              `${when.interpretation} is in the past. Schedule a future time, or use the publish tool to post now.`,
            ),
          );
        }

        // Validate against the real accounts now, so a broken job never sits
        // in the queue waiting to fail unattended.
        const config = await loadConfig();
        const prepared = prepareTargets(config, targets, content as PostContent, overrides);
        const blocking = prepared.filter((t) => errorsOf(t).length);

        if (blocking.length) {
          return failure(
            new Error(
              `Not scheduled — ${blocking.length} target(s) fail validation: ` +
                blocking
                  .map((t) => `${t.account.id} (${errorsOf(t).map((e) => e.message).join("; ")})`)
                  .join(" | "),
            ),
          );
        }

        if (!confirm) {
          return reply(
            {
              scheduled: false,
              wouldRunAt: when.iso,
              interpretation: when.interpretation,
              relative: relativeToNow(when.iso),
              repeat,
              plan: describePlan(prepared),
              warnings: when.warnings,
            },
            `Dry run — would post to ${prepared.length} account(s) ${relativeToNow(when.iso)}. ` +
              `Re-send with confirm: true to schedule.`,
          );
        }

        const job = newJob({
          scheduledFor: when.iso,
          requestedTime: when.requested,
          targets,
          content: content as PostContent,
          overrides,
          maxAttempts,
          repeat,
          note,
        });

        await withQueueLock(async (queue) => {
          queue.jobs.push(job);
          await saveQueue(queue);
        });

        return reply(
          {
            scheduled: true,
            id: job.id,
            runsAt: job.scheduledFor,
            interpretation: when.interpretation,
            relative: relativeToNow(job.scheduledFor),
            targets: prepared.map((t) => t.account.id),
            repeat,
            queueFile: queuePath(),
            warnings: [
              ...when.warnings,
              "This fires only while the MCP server is connected or `social-mcp --worker` is running.",
            ],
          },
          `Scheduled ${job.id} for ${job.scheduledFor} (${relativeToNow(job.scheduledFor)}).`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled posts",
      description:
        "Shows the scheduled-post queue: what is pending, what already ran, what failed, " +
        "and what was missed because nothing was running when it came due.",
      inputSchema: {
        status: z
          .enum(["pending", "running", "done", "failed", "cancelled", "missed", "all"])
          .default("pending"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ status, limit }) => {
      try {
        const queue = await withQueueLock((q) => q);
        const now = Date.now();
        const jobs = queue.jobs
          .filter((j) => status === "all" || j.status === status)
          .sort((a, b) => dueAt(a) - dueAt(b))
          .slice(0, limit)
          .map((j) => ({
            id: j.id,
            status: j.status,
            runsAt: j.nextAttemptAt ?? j.scheduledFor,
            relative: relativeToNow(j.nextAttemptAt ?? j.scheduledFor, now),
            targets: j.targets,
            title: j.content.topic,
            text: j.content.description?.slice(0, 120),
            repeat: j.repeat ? { ...j.repeat, completed: j.runCount ?? 0 } : undefined,
            attempts: `${j.attempts}/${j.maxAttempts}`,
            note: j.note,
            lastError: j.lastError,
            results: j.results?.map((r) => ({
              accountId: r.accountId,
              status: r.status,
              url: r.url,
              message: r.message,
            })),
          }));

        const counts = queue.jobs.reduce<Record<string, number>>((acc, j) => {
          acc[j.status] = (acc[j.status] ?? 0) + 1;
          return acc;
        }, {});

        return reply(
          { queueFile: queuePath(), counts, shown: jobs.length, jobs },
          jobs.length
            ? `${jobs.length} ${status} job(s).`
            : `No ${status} jobs in the queue.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "cancel_scheduled",
    {
      title: "Cancel a scheduled post",
      description:
        "Cancels a queued post so it never fires. Already-published posts are unaffected — " +
        "use delete_post for those.",
      inputSchema: {
        id: z.string().describe("The job id from schedule_post or list_scheduled."),
        confirm: z.boolean().default(false),
      },
    },
    async ({ id, confirm }) => {
      try {
        const result = await withQueueLock(async (queue) => {
          const job = queue.jobs.find((j) => j.id === id);
          if (!job) return { error: `No scheduled job with id "${id}".` };
          if (isTerminal(job.status)) {
            return { error: `Job ${id} already finished with status "${job.status}"; there is nothing to cancel.` };
          }
          if (!confirm) {
            return {
              preview: {
                id,
                runsAt: job.scheduledFor,
                targets: job.targets,
                title: job.content.topic,
              },
            };
          }
          job.status = "cancelled";
          job.finishedAt = new Date().toISOString();
          delete job.lock;
          await saveQueue(queue);
          return { cancelled: true };
        });

        if ("error" in result && result.error) return failure(new Error(result.error));
        if ("preview" in result) {
          return reply(
            { cancelled: false, ...result.preview },
            "Dry run — re-send with confirm: true to cancel.",
          );
        }
        return reply({ cancelled: true, id }, `Cancelled ${id}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "reschedule_post",
    {
      title: "Move a scheduled post",
      description: "Changes when a queued post fires, without rebuilding it.",
      inputSchema: {
        id: z.string(),
        scheduledFor: z.string().describe("Same formats as schedule_post."),
        timezone: z.string().optional(),
      },
    },
    async ({ id, scheduledFor, timezone }) => {
      try {
        const when = resolveWhen(scheduledFor, timezone);
        if (Date.parse(when.iso) <= Date.now()) {
          return failure(new Error(`${when.interpretation} is in the past.`));
        }

        const result = await withQueueLock(async (queue) => {
          const job = queue.jobs.find((j) => j.id === id);
          if (!job) return { error: `No scheduled job with id "${id}".` };
          if (isTerminal(job.status)) {
            return { error: `Job ${id} already finished with status "${job.status}".` };
          }
          const previous = job.scheduledFor;
          job.scheduledFor = when.iso;
          delete job.nextAttemptAt;
          job.status = "pending";
          await saveQueue(queue);
          return { previous };
        });

        if ("error" in result && result.error) return failure(new Error(result.error));
        return reply(
          {
            id,
            movedFrom: (result as { previous: string }).previous,
            runsAt: when.iso,
            relative: relativeToNow(when.iso),
            warnings: when.warnings,
          },
          `${id} now runs at ${when.iso} (${relativeToNow(when.iso)}).`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "run_due_posts",
    {
      title: "Fire due scheduled posts now",
      description:
        "Publishes every queued post whose time has arrived. The server does this " +
        "automatically on a timer while it is connected, so this is for forcing a check — " +
        "after starting up, or to flush something due moments ago. Requires confirm: true " +
        "because it publishes.",
      inputSchema: {
        confirm: z.boolean().default(false),
      },
    },
    async ({ confirm }) => {
      try {
        const now = Date.now();
        if (!confirm) {
          const queue = await withQueueLock((q) => q);
          const due = queue.jobs.filter(
            (j) => !isTerminal(j.status) && dueAt(j) <= now,
          );
          return reply(
            {
              executed: false,
              dueNow: due.map((j) => ({
                id: j.id,
                runsAt: j.scheduledFor,
                targets: j.targets,
                title: j.content.topic,
              })),
            },
            due.length
              ? `${due.length} job(s) are due. Re-send with confirm: true to publish them.`
              : "Nothing is due right now.",
          );
        }

        const tick = await runDueJobs(ctx, { now });
        // `tick` carries its own `ran` array, so the flag is named separately.
        const parts = [
          tick.ran.length ? `${tick.ran.length} published` : "",
          tick.retrying.length ? `${tick.retrying.length} will retry` : "",
          tick.failed.length ? `${tick.failed.length} failed` : "",
          tick.missed.length ? `${tick.missed.length} missed their window` : "",
        ].filter(Boolean);

        return reply(
          { executed: true, ...tick },
          parts.length ? parts.join(", ") + "." : "Nothing was due.",
        );
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
