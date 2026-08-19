import { promises as fs } from "node:fs";
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
import { firstVideo, mimeFor, readFileChunk, statMedia } from "../util/media.js";
import type { AdapterContext, Capabilities, PlatformAdapter } from "./base.js";

const PLATFORM = "youtube" as const;
const DATA_API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** 8 MiB — a multiple of 256 KiB, which the resumable protocol requires. */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Exchanges the long-lived refresh token for an access token, reusing the
 * cached one until a minute before it expires.
 */
async function accessToken(ctx: AdapterContext, account: Account): Promise<string> {
  const cached = account.session?.accessToken;
  const expiresAt = account.session?.expiresAt ?? 0;
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  const refreshToken = credential(account, "refreshToken", { required: true })!;
  const clientId = credential(account, "clientId", { required: true })!;
  const clientSecret = credential(account, "clientSecret", { required: true })!;

  const res = await request<{ access_token: string; expires_in: number }>(TOKEN_URL, {
    method: "POST",
    platform: PLATFORM,
    form: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
  });

  const session = {
    accessToken: res.access_token,
    expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
  };
  account.session = { ...account.session, ...session };
  await ctx.saveSession(account.id, session);
  return res.access_token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Drives Google's resumable upload protocol. Chunked so multi-GB videos never
 * sit in memory, and so a mid-upload failure resumes at the right offset.
 */
async function resumableUpload(
  sessionUrl: string,
  filePath: string,
  size: number,
  mime: string,
): Promise<{ id: string }> {
  let offset = 0;

  while (offset < size) {
    const length = Math.min(CHUNK_SIZE, size - offset);
    const chunk = await readFileChunk(filePath, offset, length);
    const end = offset + chunk.length - 1;

    const res = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "content-length": String(chunk.length),
        "content-range": `bytes ${offset}-${end}/${size}`,
        "content-type": mime,
      },
      body: new Uint8Array(chunk),
    });

    if (res.status === 308) {
      // Google reports how much it actually stored; trust that over our counter.
      const range = res.headers.get("range");
      const stored = range?.match(/bytes=0-(\d+)/)?.[1];
      offset = stored ? Number(stored) + 1 : offset + chunk.length;
      debug(`youtube upload at ${offset}/${size}`);
      continue;
    }

    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      if (!body.id) {
        throw new ApiError("YouTube finished the upload but returned no video id.", {
          platform: PLATFORM,
        });
      }
      return { id: body.id };
    }

    const text = await res.text().catch(() => "");
    throw new ApiError(
      `YouTube rejected the upload at byte ${offset}: ${text.slice(0, 300)}`,
      { platform: PLATFORM, status: res.status, body: text.slice(0, 800) },
    );
  }

  throw new ApiError("YouTube upload ended without a completion response.", {
    platform: PLATFORM,
  });
}

export const youtubeAdapter: PlatformAdapter = {
  platform: PLATFORM,

  capabilities: {
    captionLimit: 5000,
    media: { image: false, video: true, maxItems: 1, required: true },
    requiresPublicUrl: false,
    supportsThread: false,
    supportsFirstComment: true,
    supportsScheduling: true,
    supportsDelete: true,
    supportsReply: true,
    asyncPublish: false,
    maxHashtags: 15,
  } satisfies Capabilities,

  validate(content: PostContent): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (content.topic && content.topic.length > 100) {
      issues.push({
        level: "error",
        field: "topic",
        message: `YouTube titles are capped at 100 characters; this one is ${content.topic.length}.`,
      });
    }
    if (!content.topic) {
      issues.push({
        level: "warning",
        field: "topic",
        message: "No topic given — YouTube needs a title, so the first line of the description will be used.",
      });
    }
    if (content.scheduledAt && Number.isNaN(Date.parse(content.scheduledAt))) {
      issues.push({
        level: "error",
        field: "scheduledAt",
        message: "scheduledAt must be an ISO-8601 timestamp.",
      });
    }
    return issues;
  },

  async verify(ctx, account): Promise<AccountProfile> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      items?: Array<{
        id: string;
        snippet?: { title?: string; customUrl?: string };
        statistics?: {
          subscriberCount?: string;
          videoCount?: string;
          viewCount?: string;
        };
      }>;
    }>(`${DATA_API}/channels`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: { part: "snippet,statistics", mine: true },
    });

    const channel = res.items?.[0];
    if (!channel) {
      throw new ApiError(
        "No YouTube channel is attached to these credentials. The OAuth client must be authorized by the channel owner.",
        { platform: PLATFORM },
      );
    }
    return {
      accountId: account.id,
      platform: PLATFORM,
      handle: channel.snippet?.customUrl ?? account.handle,
      displayName: channel.snippet?.title,
      followers: Number(channel.statistics?.subscriberCount ?? 0),
      postCount: Number(channel.statistics?.videoCount ?? 0),
      raw: { channelId: channel.id, totalViews: channel.statistics?.viewCount },
    };
  },

  async publish(ctx, account, content): Promise<PublishResult> {
    const token = await accessToken(ctx, account);
    const video = firstVideo(content);
    if (!video) {
      throw new ValidationError("YouTube needs a video file (media[].kind = 'video').");
    }
    const { size, path: filePath } = await statMedia(video);
    const warnings: string[] = [];

    const title = (content.topic ?? content.description ?? "Untitled").slice(0, 100);
    if (!content.topic) {
      warnings.push("No topic supplied; the title was taken from the description.");
    }

    const tags = (content.hashtags ?? []).map((t) => t.replace(/^#/, "")).slice(0, 15);
    const description = [content.description, tags.map((t) => `#${t}`).join(" ")]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 5000);

    const scheduled = Boolean(content.scheduledAt);
    const privacyStatus = scheduled
      ? "private" // required: a scheduled video must be private until publishAt
      : content.privacy === "private"
        ? "private"
        : content.privacy === "unlisted"
          ? "unlisted"
          : "public";

    const overrides = content.platformOverrides?.youtube ?? {};
    const metadata = {
      snippet: {
        title,
        description,
        tags,
        categoryId: "22",
        ...(overrides.snippet as object | undefined),
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
        ...(scheduled ? { publishAt: new Date(content.scheduledAt!).toISOString() } : {}),
        ...(overrides.status as object | undefined),
      },
    };

    // Step 1: open a resumable session and get the upload URL from the Location header.
    const init = await fetch(
      `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          ...bearer(token),
          "content-type": "application/json",
          "x-upload-content-length": String(size),
          "x-upload-content-type": mimeFor(filePath),
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!init.ok) {
      const text = await init.text().catch(() => "");
      throw new ApiError(
        `YouTube refused to start the upload: ${text.slice(0, 300)}`,
        { platform: PLATFORM, status: init.status, body: text.slice(0, 800) },
      );
    }
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl) {
      throw new ApiError("YouTube did not return a resumable upload URL.", {
        platform: PLATFORM,
      });
    }

    // Step 2: stream the file up in chunks.
    const { id: videoId } = await resumableUpload(
      sessionUrl,
      filePath,
      size,
      mimeFor(filePath),
    );

    // Step 3: optional custom thumbnail.
    if (video.thumbnailPath) {
      try {
        const bytes = await fs.readFile(video.thumbnailPath);
        await request(`${UPLOAD_API}/thumbnails/set`, {
          method: "POST",
          platform: PLATFORM,
          headers: { ...bearer(token), "content-type": mimeFor(video.thumbnailPath) },
          query: { videoId },
          raw: bytes,
        });
      } catch (err) {
        warnings.push(`Thumbnail upload failed: ${describeError(err)}`);
      }
    }

    if (content.firstComment) {
      try {
        await request(`${DATA_API}/commentThreads`, {
          method: "POST",
          platform: PLATFORM,
          headers: bearer(token),
          query: { part: "snippet" },
          body: {
            snippet: {
              videoId,
              topLevelComment: { snippet: { textOriginal: content.firstComment } },
            },
          },
        });
      } catch (err) {
        warnings.push(`Video uploaded but the first comment failed: ${describeError(err)}`);
      }
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      status: scheduled ? "scheduled" : "published",
      postId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      message: scheduled
        ? `Uploaded as private; goes live at ${content.scheduledAt}.`
        : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async accountAnalytics(ctx, account, range: DateRange): Promise<AccountAnalytics> {
    const token = await accessToken(ctx, account);
    const metrics = [
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "likes",
      "comments",
      "shares",
      "subscribersGained",
      "subscribersLost",
    ];

    const res = await request<{
      columnHeaders?: Array<{ name: string }>;
      rows?: Array<Array<string | number>>;
    }>(`${ANALYTICS_API}/reports`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: {
        ids: "channel==MINE",
        startDate: range.since,
        endDate: range.until,
        metrics: metrics.join(","),
        dimensions: "day",
        sort: "day",
      },
    });

    const headers = res.columnHeaders?.map((h) => h.name) ?? [];
    const series: SeriesPoint[] = [];
    const totals: Record<string, number> = {};

    for (const row of res.rows ?? []) {
      const entry: Record<string, number> = {};
      let date = "";
      row.forEach((value, i) => {
        const name = headers[i];
        if (!name) return;
        if (name === "day") {
          date = String(value);
          return;
        }
        const num = typeof value === "number" ? value : Number(value) || 0;
        entry[name] = num;
        totals[name] = (totals[name] ?? 0) + num;
      });
      if (date) series.push({ date, ...entry });
    }

    // averageViewDuration is a rate, so summing it is meaningless — average instead.
    if (series.length && totals.averageViewDuration !== undefined) {
      totals.averageViewDuration = Math.round(totals.averageViewDuration / series.length);
    }
    totals.netSubscribers =
      (totals.subscribersGained ?? 0) - (totals.subscribersLost ?? 0);

    return { accountId: account.id, platform: PLATFORM, range, totals, series };
  },

  async postAnalytics(ctx, account, postId): Promise<PostAnalytics> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      items?: Array<{
        snippet?: { title?: string; publishedAt?: string; description?: string };
        statistics?: Record<string, string>;
      }>;
    }>(`${DATA_API}/videos`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: { part: "snippet,statistics", id: postId },
    });

    const video = res.items?.[0];
    if (!video) {
      throw new ApiError(`No video with id ${postId} is visible to this channel.`, {
        platform: PLATFORM,
      });
    }
    const stats = video.statistics ?? {};
    const metrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(stats)) {
      metrics[key.replace(/Count$/, "")] = Number(value) || 0;
    }

    const notes: string[] = [];
    try {
      const report = await request<{
        columnHeaders?: Array<{ name: string }>;
        rows?: Array<Array<string | number>>;
      }>(`${ANALYTICS_API}/reports`, {
        platform: PLATFORM,
        headers: bearer(token),
        query: {
          ids: "channel==MINE",
          startDate: "2005-02-14", // YouTube's launch: effectively "all time"
          endDate: new Date().toISOString().slice(0, 10),
          metrics: "estimatedMinutesWatched,averageViewPercentage,subscribersGained",
          filters: `video==${postId}`,
        },
      });
      const headers = report.columnHeaders?.map((h) => h.name) ?? [];
      report.rows?.[0]?.forEach((value, i) => {
        const name = headers[i];
        if (name) metrics[name] = Number(value) || 0;
      });
    } catch (err) {
      notes.push(`Retention metrics unavailable: ${describeError(err)}`);
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      postId,
      url: `https://www.youtube.com/watch?v=${postId}`,
      publishedAt: video.snippet?.publishedAt,
      caption: video.snippet?.title,
      metrics,
      notes: notes.length ? notes : undefined,
    };
  },

  async listPosts(ctx, account, limit): Promise<PostSummary[]> {
    const token = await accessToken(ctx, account);
    const search = await request<{
      items?: Array<{ id?: { videoId?: string } }>;
    }>(`${DATA_API}/search`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: {
        part: "id",
        forMine: true,
        type: "video",
        order: "date",
        maxResults: Math.min(limit, 50),
      },
    });

    const ids = (search.items ?? [])
      .map((i) => i.id?.videoId)
      .filter((v): v is string => Boolean(v));
    if (!ids.length) return [];

    const details = await request<{
      items?: Array<{
        id: string;
        snippet?: { title?: string; publishedAt?: string };
        statistics?: Record<string, string>;
      }>;
    }>(`${DATA_API}/videos`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: { part: "snippet,statistics", id: ids.join(",") },
    });

    return (details.items ?? []).map((v) => ({
      postId: v.id,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      publishedAt: v.snippet?.publishedAt,
      caption: v.snippet?.title,
      mediaType: "video",
      metrics: {
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
      },
    }));
  },

  async listComments(ctx, account, postId, limit): Promise<CommentItem[]> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      items?: Array<{
        id: string;
        snippet?: {
          totalReplyCount?: number;
          topLevelComment?: {
            id: string;
            snippet?: {
              textDisplay?: string;
              authorDisplayName?: string;
              publishedAt?: string;
              likeCount?: number;
            };
          };
        };
      }>;
    }>(`${DATA_API}/commentThreads`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: {
        part: "snippet",
        videoId: postId,
        maxResults: Math.min(limit, 100),
        order: "time",
      },
    });

    return (res.items ?? []).map((thread) => {
      const top = thread.snippet?.topLevelComment;
      return {
        id: top?.id ?? thread.id,
        author: top?.snippet?.authorDisplayName,
        text: top?.snippet?.textDisplay ?? "",
        createdAt: top?.snippet?.publishedAt,
        likeCount: top?.snippet?.likeCount,
        replyCount: thread.snippet?.totalReplyCount,
      };
    });
  },

  async replyToComment(ctx, account, args) {
    const token = await accessToken(ctx, account);
    if (args.commentId) {
      const res = await request<{ id: string }>(`${DATA_API}/comments`, {
        method: "POST",
        platform: PLATFORM,
        headers: bearer(token),
        query: { part: "snippet" },
        body: { snippet: { parentId: args.commentId, textOriginal: args.text } },
      });
      return { id: res.id };
    }
    if (!args.postId) {
      throw new ValidationError("Provide either commentId or postId.");
    }
    const res = await request<{ id: string }>(`${DATA_API}/commentThreads`, {
      method: "POST",
      platform: PLATFORM,
      headers: bearer(token),
      query: { part: "snippet" },
      body: {
        snippet: {
          videoId: args.postId,
          topLevelComment: { snippet: { textOriginal: args.text } },
        },
      },
    });
    return { id: res.id };
  },

  async deletePost(ctx, account, postId) {
    const token = await accessToken(ctx, account);
    await request(`${DATA_API}/videos`, {
      method: "DELETE",
      platform: PLATFORM,
      headers: bearer(token),
      query: { id: postId },
    });
  },
};
