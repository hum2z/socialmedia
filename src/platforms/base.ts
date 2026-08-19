import type {
  Account,
  AccountAnalytics,
  AccountProfile,
  CommentItem,
  DateRange,
  Platform,
  PostAnalytics,
  PostContent,
  PostSummary,
  PublishResult,
  ValidationIssue,
} from "../types.js";

/** What a platform can actually do, used for validation and for list_accounts. */
export interface Capabilities {
  /** Hard character limit for the caption/description field. */
  captionLimit: number;
  /** Media the platform will accept. */
  media: {
    image: boolean;
    video: boolean;
    /** Max attachments in one post. */
    maxItems: number;
    /** True when the platform refuses to publish without media. */
    required: boolean;
  };
  /** Media must be reachable at a public URL (no local upload path). */
  requiresPublicUrl: boolean;
  supportsThread: boolean;
  supportsFirstComment: boolean;
  supportsScheduling: boolean;
  supportsDelete: boolean;
  supportsReply: boolean;
  /** Publishing is asynchronous and needs get_publish_status polling. */
  asyncPublish: boolean;
  maxHashtags: number;
}

export interface AdapterContext {
  /** Persist a refreshed token back to the registry. */
  saveSession(accountId: string, session: Account["session"]): Promise<void>;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: Capabilities;

  /** Confirms credentials work and returns the profile. */
  verify(ctx: AdapterContext, account: Account): Promise<AccountProfile>;

  /** Platform-specific checks beyond the generic capability rules. */
  validate?(content: PostContent, account: Account): ValidationIssue[];

  publish(
    ctx: AdapterContext,
    account: Account,
    content: PostContent,
  ): Promise<PublishResult>;

  /** Only required when capabilities.asyncPublish is true. */
  publishStatus?(
    ctx: AdapterContext,
    account: Account,
    jobRef: string,
  ): Promise<PublishResult>;

  accountAnalytics(
    ctx: AdapterContext,
    account: Account,
    range: DateRange,
  ): Promise<AccountAnalytics>;

  postAnalytics(
    ctx: AdapterContext,
    account: Account,
    postId: string,
  ): Promise<PostAnalytics>;

  listPosts(
    ctx: AdapterContext,
    account: Account,
    limit: number,
  ): Promise<PostSummary[]>;

  listComments(
    ctx: AdapterContext,
    account: Account,
    postId: string,
    limit: number,
  ): Promise<CommentItem[]>;

  replyToComment?(
    ctx: AdapterContext,
    account: Account,
    args: { commentId?: string; postId?: string; text: string },
  ): Promise<{ id: string; url?: string }>;

  deletePost?(
    ctx: AdapterContext,
    account: Account,
    postId: string,
  ): Promise<void>;
}

/**
 * Generic pre-flight applied to every platform before its own validate() runs.
 * Catches the mistakes that would otherwise surface as opaque API errors.
 */
export function checkCapabilities(
  adapter: PlatformAdapter,
  content: PostContent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const caps = adapter.capabilities;
  const media = content.media ?? [];
  const body = [content.topic, content.description].filter(Boolean).join("\n\n");

  if (caps.media.required && media.length === 0) {
    issues.push({
      level: "error",
      field: "media",
      message: `${adapter.platform} cannot publish a text-only post; attach at least one media item.`,
    });
  }
  if (media.length > caps.media.maxItems) {
    issues.push({
      level: "error",
      field: "media",
      message: `${adapter.platform} accepts at most ${caps.media.maxItems} media item(s); ${media.length} were supplied.`,
    });
  }
  for (const item of media) {
    if (item.kind === "video" && !caps.media.video) {
      issues.push({
        level: "error",
        field: "media",
        message: `${adapter.platform} does not accept video through this server.`,
      });
    }
    if (item.kind === "image" && !caps.media.image) {
      issues.push({
        level: "error",
        field: "media",
        message: `${adapter.platform} does not accept images through this server.`,
      });
    }
    if (!item.url && !item.path) {
      issues.push({
        level: "error",
        field: "media",
        message: "Each media item needs either a url or a path.",
      });
    }
    if (caps.requiresPublicUrl && !item.url) {
      issues.push({
        level: "error",
        field: "media",
        message: `${adapter.platform} ingests media by URL only — supply media[].url, not just a local path.`,
      });
    }
  }

  if (body.length > caps.captionLimit) {
    issues.push({
      level: "warning",
      field: "description",
      message: `Text is ${body.length} chars, over the ${caps.captionLimit} limit for ${adapter.platform}; it will be truncated on a word boundary.`,
    });
  }
  if ((content.hashtags?.length ?? 0) > caps.maxHashtags) {
    issues.push({
      level: "warning",
      field: "hashtags",
      message: `${adapter.platform} counts at most ${caps.maxHashtags} hashtags; the extras will be dropped.`,
    });
  }
  if (content.thread?.length && !caps.supportsThread) {
    issues.push({
      level: "warning",
      field: "thread",
      message: `${adapter.platform} has no threads; the extra entries will be ignored.`,
    });
  }
  if (content.firstComment && !caps.supportsFirstComment) {
    issues.push({
      level: "warning",
      field: "firstComment",
      message: `${adapter.platform} cannot auto-post a first comment here; it will be skipped.`,
    });
  }
  if (content.scheduledAt && !caps.supportsScheduling) {
    issues.push({
      level: "warning",
      field: "scheduledAt",
      message: `${adapter.platform} has no native scheduling through its API; the post would go out immediately.`,
    });
  }
  return issues;
}

/** Defaults an analytics window to the trailing 28 days. */
export function defaultRange(range?: Partial<DateRange>): DateRange {
  const until = range?.until ?? new Date().toISOString().slice(0, 10);
  if (range?.since) return { since: range.since, until };
  const start = new Date(`${until}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 27);
  return { since: start.toISOString().slice(0, 10), until };
}

export function sumSeries(
  series: Array<Record<string, unknown>>,
  metrics: string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const metric of metrics) {
    totals[metric] = series.reduce((acc, row) => {
      const value = row[metric];
      return acc + (typeof value === "number" ? value : 0);
    }, 0);
  }
  return totals;
}
