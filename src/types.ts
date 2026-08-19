/** Shared domain types for the social MCP server. */

export const PLATFORMS = [
  "instagram",
  "youtube",
  "tiktok",
  "x",
  "linkedin",
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** A single connected account. One entry per handle, so a platform can hold many. */
export interface Account {
  /** Stable, human-chosen id used everywhere as the target selector, e.g. "ig_main". */
  id: string;
  platform: Platform;
  /** Human label shown in listings, e.g. "Main brand account". */
  label?: string;
  /** Public handle, e.g. "@acme" or a channel name. Display only. */
  handle?: string;
  /** Free-form tags so a caller can target groups, e.g. ["brand", "en"]. */
  tags?: string[];
  /**
   * Platform credentials. Any string value may use `env:VAR_NAME` indirection,
   * which is resolved from the process environment at call time. This keeps
   * long-lived secrets out of the config file.
   */
  credentials: Record<string, string>;
  /** Adapter-managed cache of refreshed short-lived tokens. */
  session?: {
    accessToken?: string;
    /** Epoch millis. */
    expiresAt?: number;
    refreshToken?: string;
  };
  /** Set false to keep an account configured but excluded from `all` targeting. */
  enabled?: boolean;
}

export interface Config {
  version: 1;
  accounts: Account[];
  defaults?: {
    /** Accounts targeted when a publish call omits `targets`. */
    targets?: string[];
  };
}

/** Media attached to a post. Exactly one of url/path is required. */
export interface MediaInput {
  /** Publicly reachable URL. Required by Instagram and by TikTok pull-from-url. */
  url?: string;
  /** Local file path. Used by YouTube, X and TikTok file uploads. */
  path?: string;
  kind: "image" | "video";
  /** Alt text where the platform supports it (X, LinkedIn). */
  altText?: string;
  /** Cover/thumbnail image for video posts, where supported. */
  thumbnailPath?: string;
}

/**
 * Platform-neutral description of what to post. Adapters map this onto their
 * own field names and enforce their own limits.
 */
export interface PostContent {
  /** Short headline. Becomes the YouTube title and the TikTok caption title. */
  topic?: string;
  /** Main body: caption, description or tweet text. */
  description?: string;
  /** Hashtags without the leading '#'. Appended per platform convention. */
  hashtags?: string[];
  media?: MediaInput[];
  /** Posted as a first comment once the post lands, where supported. */
  firstComment?: string;
  /** Additional tweets/replies chained under the first post (X only). */
  thread?: string[];
  privacy?: "public" | "private" | "unlisted";
  /** ISO-8601. Only honored by platforms with native scheduling (YouTube). */
  scheduledAt?: string;
  /** Per-platform escape hatch, merged into the outgoing request body. */
  platformOverrides?: Partial<Record<Platform, Record<string, unknown>>>;
}

export interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export interface PublishResult {
  accountId: string;
  platform: Platform;
  status: "published" | "processing" | "scheduled" | "failed";
  postId?: string;
  url?: string;
  /** Opaque handle for `get_publish_status` while status is "processing". */
  jobRef?: string;
  message?: string;
  warnings?: string[];
}

export interface AccountProfile {
  accountId: string;
  platform: Platform;
  handle?: string;
  displayName?: string;
  followers?: number;
  following?: number;
  postCount?: number;
  /** Remaining posts in the platform's rolling publish window, when exposed. */
  quotaRemaining?: number;
  raw?: Record<string, unknown>;
}

export interface MetricSet {
  [metric: string]: number | undefined;
}

/** One day of metrics. The date is a string, so this cannot be a MetricSet. */
export interface SeriesPoint {
  date: string;
  [metric: string]: number | string | undefined;
}

export interface AccountAnalytics {
  accountId: string;
  platform: Platform;
  range: { since: string; until: string };
  /** Aggregate totals across the range. */
  totals: MetricSet;
  /** Per-day breakdown where the platform exposes it. */
  series?: SeriesPoint[];
  notes?: string[];
}

export interface PostAnalytics {
  accountId: string;
  platform: Platform;
  postId: string;
  url?: string;
  publishedAt?: string;
  caption?: string;
  metrics: MetricSet;
  notes?: string[];
}

export interface PostSummary {
  postId: string;
  url?: string;
  publishedAt?: string;
  caption?: string;
  mediaType?: string;
  metrics?: MetricSet;
}

export interface CommentItem {
  id: string;
  author?: string;
  text: string;
  createdAt?: string;
  likeCount?: number;
  replyCount?: number;
  /** Present when the item is itself a reply. */
  parentId?: string;
}

export interface DateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}
