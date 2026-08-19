import { credential } from "../config.js";
import type {
  Account,
  AccountAnalytics,
  AccountProfile,
  CommentItem,
  DateRange,
  PostAnalytics,
  PostContent,
  PostSummary,
  PublishResult,
  SeriesPoint,
  ValidationIssue,
} from "../types.js";
import { ApiError, ValidationError, describeError } from "../util/errors.js";
import { request } from "../util/http.js";
import { debug } from "../util/logger.js";
import { composeCaption, images, firstVideo, requireUrl } from "../util/media.js";
import type { AdapterContext, Capabilities, PlatformAdapter } from "./base.js";

const API_VERSION = process.env.IG_API_VERSION ?? "v23.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const PLATFORM = "instagram" as const;

/**
 * Instagram publishing is a two-step container flow: create a media container,
 * wait for the platform to finish transcoding it, then publish the container.
 * Video and Reels containers are always asynchronous.
 */
function auth(account: Account) {
  return {
    igUserId: credential(account, "igUserId", { required: true })!,
    accessToken: credential(account, "accessToken", { required: true })!,
  };
}

async function createContainer(
  igUserId: string,
  accessToken: string,
  fields: Record<string, string | undefined>,
): Promise<string> {
  const res = await request<{ id: string }>(`${BASE}/${igUserId}/media`, {
    method: "POST",
    platform: PLATFORM,
    form: { ...fields, access_token: accessToken },
  });
  if (!res?.id) {
    throw new ApiError("Instagram did not return a media container id.", {
      platform: PLATFORM,
    });
  }
  return res.id;
}

interface ContainerStatus {
  status_code?: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
  status?: string;
}

async function containerStatus(
  containerId: string,
  accessToken: string,
): Promise<ContainerStatus> {
  return request<ContainerStatus>(`${BASE}/${containerId}`, {
    platform: PLATFORM,
    query: { fields: "status_code,status", access_token: accessToken },
  });
}

/** Polls a container until it is ready to publish. */
async function waitForContainer(
  containerId: string,
  accessToken: string,
  { attempts = 20, intervalMs = 3000 } = {},
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const status = await containerStatus(containerId, accessToken);
    debug(`ig container ${containerId}: ${status.status_code}`);
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new ApiError(
        `Instagram could not process the media (${status.status_code}): ${
          status.status ?? "no detail given"
        }. Check the file meets Instagram's codec, duration and aspect-ratio rules.`,
        { platform: PLATFORM },
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new ApiError(
    `Instagram is still transcoding container ${containerId} after ${
      (attempts * intervalMs) / 1000
    }s. It may still succeed — re-check with get_publish_status.`,
    { platform: PLATFORM, retryable: true },
  );
}

async function publishContainer(
  igUserId: string,
  accessToken: string,
  creationId: string,
): Promise<string> {
  const res = await request<{ id: string }>(`${BASE}/${igUserId}/media_publish`, {
    method: "POST",
    platform: PLATFORM,
    form: { creation_id: creationId, access_token: accessToken },
  });
  return res.id;
}

export const instagramAdapter: PlatformAdapter = {
  platform: PLATFORM,

  capabilities: {
    captionLimit: 2200,
    media: { image: true, video: true, maxItems: 10, required: true },
    requiresPublicUrl: true,
    supportsThread: false,
    supportsFirstComment: true,
    supportsScheduling: false,
    supportsDelete: false,
    supportsReply: true,
    asyncPublish: true,
    maxHashtags: 30,
  } satisfies Capabilities,

  validate(content: PostContent): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const media = content.media ?? [];
    const vids = media.filter((m) => m.kind === "video").length;
    if (vids > 0 && media.length > 1 && vids !== media.length) {
      issues.push({
        level: "warning",
        field: "media",
        message:
          "Mixed image/video carousels are supported but every item must meet Instagram's aspect-ratio rules or the container will error.",
      });
    }
    return issues;
  },

  async verify(_ctx, account): Promise<AccountProfile> {
    const { igUserId, accessToken } = auth(account);
    const profile = await request<{
      id: string;
      username?: string;
      name?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
    }>(`${BASE}/${igUserId}`, {
      platform: PLATFORM,
      query: {
        fields: "id,username,name,followers_count,follows_count,media_count",
        access_token: accessToken,
      },
    });

    // Instagram caps publishing at 50 posts per rolling 24h; surface what's left.
    let quotaRemaining: number | undefined;
    try {
      const limit = await request<{
        data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
      }>(`${BASE}/${igUserId}/content_publishing_limit`, {
        platform: PLATFORM,
        query: { fields: "config,quota_usage", access_token: accessToken },
      });
      const row = limit.data?.[0];
      if (row) {
        const total = row.config?.quota_total ?? 50;
        quotaRemaining = Math.max(total - (row.quota_usage ?? 0), 0);
      }
    } catch (err) {
      debug("ig quota lookup failed", describeError(err));
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      handle: profile.username ? `@${profile.username}` : account.handle,
      displayName: profile.name,
      followers: profile.followers_count,
      following: profile.follows_count,
      postCount: profile.media_count,
      quotaRemaining,
    };
  },

  async publish(_ctx, account, content): Promise<PublishResult> {
    const { igUserId, accessToken } = auth(account);
    const { text: caption, truncated } = composeCaption(content, {
      limit: this.capabilities.captionLimit,
      includeTopic: true,
      hashtagLimit: 30,
    });
    const warnings: string[] = [];
    if (truncated) warnings.push("Caption exceeded 2200 chars and was truncated.");

    const media = content.media ?? [];
    if (media.length === 0) {
      throw new ValidationError("Instagram requires at least one media item.");
    }
    const overrides = (content.platformOverrides?.instagram ?? {}) as Record<
      string,
      string
    >;

    let creationId: string;

    if (media.length === 1) {
      const item = media[0]!;
      const url = requireUrl(item, "Instagram");
      creationId =
        item.kind === "video"
          ? await createContainer(igUserId, accessToken, {
              media_type: "REELS",
              video_url: url,
              caption,
              share_to_feed: "true",
              ...overrides,
            })
          : await createContainer(igUserId, accessToken, {
              image_url: url,
              caption,
              ...overrides,
            });
    } else {
      // Carousel: build every child first, then a parent that references them.
      const children: string[] = [];
      for (const item of media) {
        const url = requireUrl(item, "Instagram");
        const childId = await createContainer(igUserId, accessToken, {
          is_carousel_item: "true",
          ...(item.kind === "video"
            ? { media_type: "VIDEO", video_url: url }
            : { image_url: url }),
        });
        children.push(childId);
      }
      for (const child of children) {
        await waitForContainer(child, accessToken);
      }
      creationId = await createContainer(igUserId, accessToken, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption,
        ...overrides,
      });
    }

    await waitForContainer(creationId, accessToken);
    const mediaId = await publishContainer(igUserId, accessToken, creationId);

    if (content.firstComment) {
      try {
        await request(`${BASE}/${mediaId}/comments`, {
          method: "POST",
          platform: PLATFORM,
          form: { message: content.firstComment, access_token: accessToken },
        });
      } catch (err) {
        warnings.push(`Post published but the first comment failed: ${describeError(err)}`);
      }
    }

    let url: string | undefined;
    try {
      const permalink = await request<{ permalink?: string }>(`${BASE}/${mediaId}`, {
        platform: PLATFORM,
        query: { fields: "permalink", access_token: accessToken },
      });
      url = permalink.permalink;
    } catch {
      /* permalink is a nicety, not worth failing the publish over */
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "published",
      postId: mediaId,
      url,
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async publishStatus(_ctx, account, jobRef): Promise<PublishResult> {
    const { igUserId, accessToken } = auth(account);
    const status = await containerStatus(jobRef, accessToken);
    if (status.status_code === "FINISHED") {
      const mediaId = await publishContainer(igUserId, accessToken, jobRef);
      return {
        accountId: account.id,
        platform: PLATFORM,
        status: "published",
        postId: mediaId,
      };
    }
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      return {
        accountId: account.id,
        platform: PLATFORM,
        status: "failed",
        message: status.status ?? status.status_code,
      };
    }
    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "processing",
      jobRef,
      message: `Container is ${status.status_code ?? "IN_PROGRESS"}.`,
    };
  },

  async accountAnalytics(_ctx, account, range: DateRange): Promise<AccountAnalytics> {
    const { igUserId, accessToken } = auth(account);
    const notes: string[] = [];
    const totals: Record<string, number> = {};
    const byDate = new Map<string, Record<string, number>>();

    // Instagram splits insights across two shapes: day time-series and
    // total_value aggregates. Each is requested separately and failures on one
    // metric family must not lose the other.
    const timeSeries = ["reach", "views", "profile_views"];
    try {
      const res = await request<{
        data?: Array<{
          name: string;
          values?: Array<{ value: number; end_time?: string }>;
        }>;
      }>(`${BASE}/${igUserId}/insights`, {
        platform: PLATFORM,
        query: {
          metric: timeSeries.join(","),
          period: "day",
          metric_type: "time_series",
          since: range.since,
          until: range.until,
          access_token: accessToken,
        },
      });
      for (const metric of res.data ?? []) {
        let sum = 0;
        for (const point of metric.values ?? []) {
          sum += point.value ?? 0;
          const date = point.end_time?.slice(0, 10);
          if (!date) continue;
          const row = byDate.get(date) ?? {};
          row[metric.name] = point.value ?? 0;
          byDate.set(date, row);
        }
        totals[metric.name] = sum;
      }
    } catch (err) {
      notes.push(`Day-level metrics unavailable: ${describeError(err)}`);
    }

    const aggregates = ["likes", "comments", "shares", "saves", "total_interactions", "accounts_engaged"];
    try {
      const res = await request<{
        data?: Array<{ name: string; total_value?: { value?: number } }>;
      }>(`${BASE}/${igUserId}/insights`, {
        platform: PLATFORM,
        query: {
          metric: aggregates.join(","),
          period: "day",
          metric_type: "total_value",
          since: range.since,
          until: range.until,
          access_token: accessToken,
        },
      });
      for (const metric of res.data ?? []) {
        totals[metric.name] = metric.total_value?.value ?? 0;
      }
    } catch (err) {
      notes.push(`Interaction totals unavailable: ${describeError(err)}`);
    }

    try {
      const profile = await request<{ followers_count?: number }>(`${BASE}/${igUserId}`, {
        platform: PLATFORM,
        query: { fields: "followers_count", access_token: accessToken },
      });
      if (profile.followers_count !== undefined) {
        totals.followers = profile.followers_count;
      }
    } catch {
      /* non-fatal */
    }

    const series = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, metrics]) => ({ date, ...metrics }));

    return {
      accountId: account.id,
      platform: PLATFORM,
      range,
      totals,
      series,
      notes: notes.length ? notes : undefined,
    };
  },

  async postAnalytics(_ctx, account, postId): Promise<PostAnalytics> {
    const { accessToken } = auth(account);
    const meta = await request<{
      id: string;
      caption?: string;
      permalink?: string;
      timestamp?: string;
      media_type?: string;
      like_count?: number;
      comments_count?: number;
    }>(`${BASE}/${postId}`, {
      platform: PLATFORM,
      query: {
        fields: "id,caption,permalink,timestamp,media_type,like_count,comments_count",
        access_token: accessToken,
      },
    });

    const metrics: Record<string, number> = {};
    if (meta.like_count !== undefined) metrics.likes = meta.like_count;
    if (meta.comments_count !== undefined) metrics.comments = meta.comments_count;

    const notes: string[] = [];
    try {
      const insights = await request<{
        data?: Array<{ name: string; values?: Array<{ value: number }> }>;
      }>(`${BASE}/${postId}/insights`, {
        platform: PLATFORM,
        query: {
          metric: "reach,views,saved,shares,total_interactions",
          access_token: accessToken,
        },
      });
      for (const metric of insights.data ?? []) {
        metrics[metric.name] = metric.values?.[0]?.value ?? 0;
      }
    } catch (err) {
      notes.push(
        `Insight metrics unavailable for this media (older posts and some media types are not covered): ${describeError(err)}`,
      );
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      postId,
      url: meta.permalink,
      publishedAt: meta.timestamp,
      caption: meta.caption,
      metrics,
      notes: notes.length ? notes : undefined,
    };
  },

  async listPosts(_ctx, account, limit): Promise<PostSummary[]> {
    const { igUserId, accessToken } = auth(account);
    const res = await request<{
      data?: Array<{
        id: string;
        caption?: string;
        permalink?: string;
        timestamp?: string;
        media_type?: string;
        like_count?: number;
        comments_count?: number;
      }>;
    }>(`${BASE}/${igUserId}/media`, {
      platform: PLATFORM,
      query: {
        fields: "id,caption,permalink,timestamp,media_type,like_count,comments_count",
        limit,
        access_token: accessToken,
      },
    });
    return (res.data ?? []).map((m) => ({
      postId: m.id,
      url: m.permalink,
      publishedAt: m.timestamp,
      caption: m.caption,
      mediaType: m.media_type,
      metrics: { likes: m.like_count ?? 0, comments: m.comments_count ?? 0 },
    }));
  },

  async listComments(_ctx, account, postId, limit): Promise<CommentItem[]> {
    const { accessToken } = auth(account);
    const res = await request<{
      data?: Array<{
        id: string;
        text?: string;
        username?: string;
        timestamp?: string;
        like_count?: number;
        replies?: { data?: Array<{ id: string }> };
      }>;
    }>(`${BASE}/${postId}/comments`, {
      platform: PLATFORM,
      query: {
        fields: "id,text,username,timestamp,like_count,replies",
        limit,
        access_token: accessToken,
      },
    });
    return (res.data ?? []).map((c) => ({
      id: c.id,
      author: c.username,
      text: c.text ?? "",
      createdAt: c.timestamp,
      likeCount: c.like_count,
      replyCount: c.replies?.data?.length,
    }));
  },

  async replyToComment(_ctx, account, args) {
    const { accessToken } = auth(account);
    // Replying to a comment posts under it; without one it becomes a top-level comment.
    const target = args.commentId
      ? `${BASE}/${args.commentId}/replies`
      : `${BASE}/${args.postId}/comments`;
    if (!args.commentId && !args.postId) {
      throw new ValidationError("Provide either commentId or postId to comment on.");
    }
    const res = await request<{ id: string }>(target, {
      method: "POST",
      platform: PLATFORM,
      form: { message: args.text, access_token: accessToken },
    });
    return { id: res.id };
  },
};
