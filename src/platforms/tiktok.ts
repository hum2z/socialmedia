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
  ValidationIssue,
} from "../types.js";
import { ApiError, ValidationError } from "../util/errors.js";
import { request } from "../util/http.js";
import { debug } from "../util/logger.js";
import { composeCaption, firstVideo, images, readFileChunk, statMedia } from "../util/media.js";
import type { AdapterContext, Capabilities, PlatformAdapter } from "./base.js";

const PLATFORM = "tiktok" as const;
const BASE = "https://open.tiktokapis.com/v2";

/** TikTok requires chunks of 5–64 MiB, with the remainder folded into the last one. */
const MIN_CHUNK = 5 * 1024 * 1024;
const TARGET_CHUNK = 10 * 1024 * 1024;

type PrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

async function accessToken(ctx: AdapterContext, account: Account): Promise<string> {
  const direct = credential(account, "accessToken");
  const cached = account.session?.accessToken;
  const expiresAt = account.session?.expiresAt ?? 0;
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  const refreshToken =
    account.session?.refreshToken ?? credential(account, "refreshToken");
  if (!refreshToken) {
    if (direct) return direct;
    throw new ValidationError(
      `TikTok account "${account.id}" needs either a refreshToken (preferred) or an accessToken credential.`,
    );
  }

  const clientKey = credential(account, "clientKey", { required: true })!;
  const clientSecret = credential(account, "clientSecret", { required: true })!;

  const res = await request<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }>(`${BASE}/oauth/token/`, {
    method: "POST",
    platform: PLATFORM,
    form: {
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });

  // TikTok rotates the refresh token on every use — losing the new one locks the account out.
  const session = {
    accessToken: res.access_token,
    expiresAt: Date.now() + (res.expires_in ?? 86_400) * 1000,
    refreshToken: res.refresh_token ?? refreshToken,
  };
  account.session = { ...account.session, ...session };
  await ctx.saveSession(account.id, session);
  return res.access_token;
}

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json; charset=UTF-8",
});

interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: PrivacyLevel[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

/**
 * TikTok requires querying creator info before every direct post: it returns
 * which privacy levels the account may actually use right now.
 */
async function creatorInfo(token: string): Promise<CreatorInfo> {
  const res = await request<{ data?: CreatorInfo; error?: { message?: string } }>(
    `${BASE}/post/publish/creator_info/query/`,
    { method: "POST", platform: PLATFORM, headers: authHeaders(token) },
  );
  return res.data ?? {};
}

function pickPrivacy(
  requested: PostContent["privacy"],
  allowed: PrivacyLevel[] | undefined,
): { level: PrivacyLevel; note?: string } {
  const wanted: PrivacyLevel =
    requested === "private" ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE";
  if (!allowed?.length) return { level: wanted };
  if (allowed.includes(wanted)) return { level: wanted };
  // Unaudited apps are restricted to SELF_ONLY; fall back rather than fail.
  const fallback = allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0]!;
  return {
    level: fallback,
    note: `TikTok does not currently allow "${wanted}" for this account (likely an unaudited app), so the post was set to "${fallback}".`,
  };
}

async function uploadInChunks(
  uploadUrl: string,
  filePath: string,
  size: number,
  chunkSize: number,
  totalChunks: number,
): Promise<void> {
  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkSize;
    // The final chunk absorbs any remainder so the byte ranges stay contiguous.
    const length = index === totalChunks - 1 ? size - start : chunkSize;
    const chunk = await readFileChunk(filePath, start, length);
    const end = start + chunk.length - 1;

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "video/mp4",
        "content-length": String(chunk.length),
        "content-range": `bytes ${start}-${end}/${size}`,
      },
      body: new Uint8Array(chunk),
    });

    if (!res.ok && res.status !== 308) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        `TikTok rejected chunk ${index + 1}/${totalChunks}: ${text.slice(0, 300)}`,
        { platform: PLATFORM, status: res.status },
      );
    }
    debug(`tiktok chunk ${index + 1}/${totalChunks} uploaded`);
  }
}

export const tiktokAdapter: PlatformAdapter = {
  platform: PLATFORM,

  capabilities: {
    captionLimit: 2200,
    media: { image: true, video: true, maxItems: 35, required: true },
    requiresPublicUrl: false,
    supportsThread: false,
    supportsFirstComment: false,
    supportsScheduling: false,
    supportsDelete: false,
    supportsReply: false,
    asyncPublish: true,
    maxHashtags: 30,
  } satisfies Capabilities,

  validate(content: PostContent): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const media = content.media ?? [];
    const hasVideo = media.some((m) => m.kind === "video");
    const hasImage = media.some((m) => m.kind === "image");
    if (hasVideo && hasImage) {
      issues.push({
        level: "error",
        field: "media",
        message: "TikTok posts are either one video or a photo carousel, not a mix.",
      });
    }
    if (hasImage && media.some((m) => !m.url)) {
      issues.push({
        level: "error",
        field: "media",
        message: "TikTok photo posts must be pulled from public URLs; local paths are not supported for photos.",
      });
    }
    return issues;
  },

  async verify(ctx, account): Promise<AccountProfile> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      data?: {
        user?: {
          display_name?: string;
          username?: string;
          follower_count?: number;
          following_count?: number;
          likes_count?: number;
          video_count?: number;
        };
      };
    }>(`${BASE}/user/info/`, {
      platform: PLATFORM,
      headers: { authorization: `Bearer ${token}` },
      query: {
        fields:
          "open_id,display_name,username,follower_count,following_count,likes_count,video_count",
      },
    });

    const user = res.data?.user ?? {};
    return {
      accountId: account.id,
      platform: PLATFORM,
      handle: user.username ? `@${user.username}` : account.handle,
      displayName: user.display_name,
      followers: user.follower_count,
      following: user.following_count,
      postCount: user.video_count,
      raw: { totalLikes: user.likes_count },
    };
  },

  async publish(ctx, account, content): Promise<PublishResult> {
    const token = await accessToken(ctx, account);
    const info = await creatorInfo(token);
    const warnings: string[] = [];

    const { text: title, truncated } = composeCaption(content, {
      limit: this.capabilities.captionLimit,
      includeTopic: true,
      hashtagLimit: 30,
    });
    if (truncated) warnings.push("Caption was truncated to TikTok's 2200-char limit.");

    const { level: privacy, note } = pickPrivacy(content.privacy, info.privacy_level_options);
    if (note) warnings.push(note);

    const overrides = (content.platformOverrides?.tiktok ?? {}) as Record<string, unknown>;
    const postInfo = {
      title,
      privacy_level: privacy,
      disable_comment: info.comment_disabled ?? false,
      disable_duet: info.duet_disabled ?? false,
      disable_stitch: info.stitch_disabled ?? false,
      ...(overrides.post_info as object | undefined),
    };

    const video = firstVideo(content);
    let publishId: string;

    if (video) {
      if (video.url) {
        const res = await request<{ data?: { publish_id?: string } }>(
          `${BASE}/post/publish/video/init/`,
          {
            method: "POST",
            platform: PLATFORM,
            headers: authHeaders(token),
            body: {
              post_info: postInfo,
              source_info: { source: "PULL_FROM_URL", video_url: video.url },
            },
          },
        );
        publishId = res.data?.publish_id ?? "";
      } else {
        const { size, path: filePath } = await statMedia(video);
        const chunkSize = size < MIN_CHUNK ? size : Math.min(TARGET_CHUNK, size);
        const totalChunks = Math.max(1, Math.floor(size / chunkSize));

        const res = await request<{
          data?: { publish_id?: string; upload_url?: string };
        }>(`${BASE}/post/publish/video/init/`, {
          method: "POST",
          platform: PLATFORM,
          headers: authHeaders(token),
          body: {
            post_info: postInfo,
            source_info: {
              source: "FILE_UPLOAD",
              video_size: size,
              chunk_size: chunkSize,
              total_chunk_count: totalChunks,
            },
          },
        });

        publishId = res.data?.publish_id ?? "";
        const uploadUrl = res.data?.upload_url;
        if (!uploadUrl) {
          throw new ApiError("TikTok did not return an upload URL.", { platform: PLATFORM });
        }
        await uploadInChunks(uploadUrl, filePath, size, chunkSize, totalChunks);
      }
    } else {
      const photos = images(content);
      if (!photos.length) {
        throw new ValidationError("TikTok needs either a video or at least one image.");
      }
      const res = await request<{ data?: { publish_id?: string } }>(
        `${BASE}/post/publish/content/init/`,
        {
          method: "POST",
          platform: PLATFORM,
          headers: authHeaders(token),
          body: {
            media_type: "PHOTO",
            post_mode: "DIRECT_POST",
            post_info: { ...postInfo, description: content.description ?? "" },
            source_info: {
              source: "PULL_FROM_URL",
              photo_cover_index: 0,
              photo_images: photos.map((p) => p.url),
            },
          },
        },
      );
      publishId = res.data?.publish_id ?? "";
    }

    if (!publishId) {
      throw new ApiError("TikTok accepted the request but returned no publish_id.", {
        platform: PLATFORM,
      });
    }

    // TikTok always finishes asynchronously; give the caller a handle to poll.
    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "processing",
      jobRef: publishId,
      message:
        "TikTok is processing the upload. Poll get_publish_status with this jobRef until it reports PUBLISH_COMPLETE.",
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async publishStatus(ctx, account, jobRef): Promise<PublishResult> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      data?: {
        status?: string;
        fail_reason?: string;
        publicaly_available_post_id?: string[];
        publicly_available_post_id?: string[];
      };
    }>(`${BASE}/post/publish/status/fetch/`, {
      method: "POST",
      platform: PLATFORM,
      headers: authHeaders(token),
      body: { publish_id: jobRef },
    });

    const data = res.data ?? {};
    // The field name is misspelled in TikTok's own API; accept both spellings.
    const postId =
      data.publicaly_available_post_id?.[0] ?? data.publicly_available_post_id?.[0];

    if (data.status === "PUBLISH_COMPLETE") {
      return {
        accountId: account.id,
        platform: PLATFORM,
        status: "published",
        postId,
        url: postId ? `https://www.tiktok.com/video/${postId}` : undefined,
      };
    }
    if (data.status === "FAILED") {
      return {
        accountId: account.id,
        platform: PLATFORM,
        status: "failed",
        message: data.fail_reason ?? "TikTok reported FAILED without a reason.",
      };
    }
    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "processing",
      jobRef,
      message: `TikTok status: ${data.status ?? "unknown"}.`,
    };
  },

  async accountAnalytics(ctx, account, range: DateRange): Promise<AccountAnalytics> {
    const token = await accessToken(ctx, account);
    const profile = await request<{
      data?: {
        user?: {
          follower_count?: number;
          following_count?: number;
          likes_count?: number;
          video_count?: number;
        };
      };
    }>(`${BASE}/user/info/`, {
      platform: PLATFORM,
      headers: { authorization: `Bearer ${token}` },
      query: {
        fields: "follower_count,following_count,likes_count,video_count",
      },
    });

    const user = profile.data?.user ?? {};
    const totals: Record<string, number> = {
      followers: user.follower_count ?? 0,
      following: user.following_count ?? 0,
      totalLikes: user.likes_count ?? 0,
      videoCount: user.video_count ?? 0,
    };

    // TikTok exposes no day-level channel report, so the window is covered by
    // summing the posts that actually fall inside it.
    const since = Date.parse(`${range.since}T00:00:00Z`) / 1000;
    const until = Date.parse(`${range.until}T23:59:59Z`) / 1000;
    const notes = [
      "TikTok's public API has no day-level account report; range metrics are summed from posts published inside the window.",
    ];

    try {
      const posts = await this.listPosts(ctx, account, 20);
      const inRange = posts.filter((p) => {
        if (!p.publishedAt) return false;
        const at = Date.parse(p.publishedAt) / 1000;
        return at >= since && at <= until;
      });
      totals.postsInRange = inRange.length;
      for (const key of ["views", "likes", "comments", "shares"]) {
        totals[key] = inRange.reduce((sum, p) => sum + (p.metrics?.[key] ?? 0), 0);
      }
    } catch (err) {
      notes.push(`Could not summarize posts in range: ${(err as Error).message}`);
    }

    return { accountId: account.id, platform: PLATFORM, range, totals, notes };
  },

  async postAnalytics(ctx, account, postId): Promise<PostAnalytics> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      data?: {
        videos?: Array<{
          id: string;
          title?: string;
          video_description?: string;
          share_url?: string;
          create_time?: number;
          view_count?: number;
          like_count?: number;
          comment_count?: number;
          share_count?: number;
        }>;
      };
    }>(`${BASE}/video/query/`, {
      method: "POST",
      platform: PLATFORM,
      headers: authHeaders(token),
      query: {
        fields:
          "id,title,video_description,share_url,create_time,view_count,like_count,comment_count,share_count",
      },
      body: { filters: { video_ids: [postId] } },
    });

    const video = res.data?.videos?.[0];
    if (!video) {
      throw new ApiError(`TikTok returned no video with id ${postId}.`, {
        platform: PLATFORM,
      });
    }
    return {
      accountId: account.id,
      platform: PLATFORM,
      postId,
      url: video.share_url,
      publishedAt: video.create_time
        ? new Date(video.create_time * 1000).toISOString()
        : undefined,
      caption: video.title ?? video.video_description,
      metrics: {
        views: video.view_count ?? 0,
        likes: video.like_count ?? 0,
        comments: video.comment_count ?? 0,
        shares: video.share_count ?? 0,
      },
    };
  },

  async listPosts(ctx, account, limit): Promise<PostSummary[]> {
    const token = await accessToken(ctx, account);
    const res = await request<{
      data?: {
        videos?: Array<{
          id: string;
          title?: string;
          video_description?: string;
          share_url?: string;
          create_time?: number;
          view_count?: number;
          like_count?: number;
          comment_count?: number;
          share_count?: number;
        }>;
      };
    }>(`${BASE}/video/list/`, {
      method: "POST",
      platform: PLATFORM,
      headers: authHeaders(token),
      query: {
        fields:
          "id,title,video_description,share_url,create_time,view_count,like_count,comment_count,share_count",
      },
      body: { max_count: Math.min(limit, 20) },
    });

    return (res.data?.videos ?? []).map((v) => ({
      postId: v.id,
      url: v.share_url,
      publishedAt: v.create_time
        ? new Date(v.create_time * 1000).toISOString()
        : undefined,
      caption: v.title ?? v.video_description,
      mediaType: "video",
      metrics: {
        views: v.view_count ?? 0,
        likes: v.like_count ?? 0,
        comments: v.comment_count ?? 0,
        shares: v.share_count ?? 0,
      },
    }));
  },

  async listComments(): Promise<CommentItem[]> {
    throw new ValidationError(
      "TikTok's public API does not expose comment reading or replying. " +
        "Comments have to be handled in the TikTok app or Business Suite.",
    );
  },
};
