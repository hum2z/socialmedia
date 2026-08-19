import { credential } from "../config.js";
import type {
  Account,
  AccountAnalytics,
  AccountProfile,
  CommentItem,
  DateRange,
  MediaInput,
  PostAnalytics,
  PostContent,
  PostSummary,
  PublishResult,
  ValidationIssue,
} from "../types.js";
import { ApiError, ValidationError, describeError } from "../util/errors.js";
import { request } from "../util/http.js";
import { debug } from "../util/logger.js";
import { composeCaption, readFileChunk, statMedia } from "../util/media.js";
import type { AdapterContext, Capabilities, PlatformAdapter } from "./base.js";

const PLATFORM = "x" as const;
const BASE = "https://api.x.com/2";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const CHUNK = 4 * 1024 * 1024;

async function accessToken(ctx: AdapterContext, account: Account): Promise<string> {
  const cached = account.session?.accessToken;
  const expiresAt = account.session?.expiresAt ?? 0;
  if (cached && expiresAt > Date.now() + 60_000) return cached;

  const refreshToken =
    account.session?.refreshToken ?? credential(account, "refreshToken");
  if (!refreshToken) {
    // Some setups issue a long-lived token directly; accept that too.
    const direct = credential(account, "accessToken");
    if (direct) return direct;
    throw new ValidationError(
      `X account "${account.id}" needs a refreshToken (OAuth 2.0 with offline.access) or an accessToken.`,
    );
  }

  const clientId = credential(account, "clientId", { required: true })!;
  const clientSecret = credential(account, "clientSecret");

  const headers: Record<string, string> = {};
  if (clientSecret) {
    // Confidential clients authenticate the refresh with HTTP Basic.
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  const res = await request<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }>(TOKEN_URL, {
    method: "POST",
    platform: PLATFORM,
    headers,
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
  });

  const session = {
    accessToken: res.access_token,
    expiresAt: Date.now() + (res.expires_in ?? 7200) * 1000,
    refreshToken: res.refresh_token ?? refreshToken,
  };
  account.session = { ...account.session, ...session };
  await ctx.saveSession(account.id, session);
  return res.access_token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** INIT → APPEND (chunked) → FINALIZE, then wait out any async transcoding. */
async function uploadMedia(
  token: string,
  media: MediaInput,
): Promise<string> {
  const { size, mime, path: filePath } = await statMedia(media);
  const category = media.kind === "video" ? "tweet_video" : "tweet_image";

  const init = await request<{ data?: { id?: string } }>(
    `${BASE}/media/upload/initialize`,
    {
      method: "POST",
      platform: PLATFORM,
      headers: bearer(token),
      body: { media_type: mime, total_bytes: size, media_category: category },
    },
  );
  const mediaId = init.data?.id;
  if (!mediaId) {
    throw new ApiError("X did not return a media id from initialize.", {
      platform: PLATFORM,
    });
  }

  let segment = 0;
  for (let offset = 0; offset < size; offset += CHUNK) {
    const chunk = await readFileChunk(filePath, offset, Math.min(CHUNK, size - offset));
    const form = new FormData();
    form.set("segment_index", String(segment));
    form.set("media", new Blob([new Uint8Array(chunk)], { type: mime }));

    const res = await fetch(`${BASE}/media/upload/${mediaId}/append`, {
      method: "POST",
      headers: bearer(token),
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(`X rejected media segment ${segment}: ${text.slice(0, 300)}`, {
        platform: PLATFORM,
        status: res.status,
      });
    }
    debug(`x media segment ${segment} uploaded`);
    segment++;
  }

  const finalized = await request<{
    data?: { id?: string; processing_info?: { state?: string; check_after_secs?: number } };
  }>(`${BASE}/media/upload/${mediaId}/finalize`, {
    method: "POST",
    platform: PLATFORM,
    headers: bearer(token),
  });

  // Video needs transcoding before it can be attached to a post.
  let info = finalized.data?.processing_info;
  let waited = 0;
  while (info && (info.state === "pending" || info.state === "in_progress")) {
    const delay = Math.min((info.check_after_secs ?? 5) * 1000, 15_000);
    if (waited > 300_000) {
      throw new ApiError("X is still transcoding this video after 5 minutes.", {
        platform: PLATFORM,
        retryable: true,
      });
    }
    await new Promise((r) => setTimeout(r, delay));
    waited += delay;
    const status = await request<{
      data?: { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } };
    }>(`${BASE}/media/upload`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: { media_id: mediaId, command: "STATUS" },
    });
    info = status.data?.processing_info;
    if (info?.state === "failed") {
      throw new ApiError(
        `X could not process the video: ${info as unknown as string}`,
        { platform: PLATFORM },
      );
    }
  }

  if (media.altText) {
    try {
      await request(`${BASE}/media/metadata`, {
        method: "POST",
        platform: PLATFORM,
        headers: bearer(token),
        body: { id: mediaId, metadata: { alt_text: { text: media.altText.slice(0, 1000) } } },
      });
    } catch (err) {
      debug("x alt text failed", describeError(err));
    }
  }

  return mediaId;
}

async function createPost(
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; text?: string }> {
  const res = await request<{ data?: { id?: string; text?: string } }>(`${BASE}/tweets`, {
    method: "POST",
    platform: PLATFORM,
    headers: bearer(token),
    body,
  });
  if (!res.data?.id) {
    throw new ApiError("X accepted the request but returned no post id.", {
      platform: PLATFORM,
    });
  }
  return { id: res.data.id, text: res.data.text };
}

async function me(token: string): Promise<{
  id: string;
  username?: string;
  name?: string;
  public_metrics?: Record<string, number>;
}> {
  const res = await request<{ data?: any }>(`${BASE}/users/me`, {
    platform: PLATFORM,
    headers: bearer(token),
    query: { "user.fields": "public_metrics,username,name" },
  });
  if (!res.data?.id) {
    throw new ApiError("X did not return the authenticated user.", { platform: PLATFORM });
  }
  return res.data;
}

export const xAdapter: PlatformAdapter = {
  platform: PLATFORM,

  capabilities: {
    captionLimit: 280,
    media: { image: true, video: true, maxItems: 4, required: false },
    requiresPublicUrl: false,
    supportsThread: true,
    supportsFirstComment: true,
    supportsScheduling: false,
    supportsDelete: true,
    supportsReply: true,
    asyncPublish: false,
    maxHashtags: 10,
  } satisfies Capabilities,

  validate(content: PostContent): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const videos = content.media?.filter((m) => m.kind === "video").length ?? 0;
    const total = content.media?.length ?? 0;
    if (videos > 1) {
      issues.push({
        level: "error",
        field: "media",
        message: "X allows only one video per post.",
      });
    }
    if (videos === 1 && total > 1) {
      issues.push({
        level: "error",
        field: "media",
        message: "X cannot mix a video with other media in one post.",
      });
    }
    for (const [i, entry] of (content.thread ?? []).entries()) {
      if (entry.length > 280) {
        issues.push({
          level: "warning",
          field: `thread[${i}]`,
          message: `Thread entry ${i + 1} is ${entry.length} chars and will be truncated.`,
        });
      }
    }
    return issues;
  },

  async verify(ctx, account): Promise<AccountProfile> {
    const token = await accessToken(ctx, account);
    const user = await me(token);
    return {
      accountId: account.id,
      platform: PLATFORM,
      handle: user.username ? `@${user.username}` : account.handle,
      displayName: user.name,
      followers: user.public_metrics?.followers_count,
      following: user.public_metrics?.following_count,
      postCount: user.public_metrics?.tweet_count,
    };
  },

  async publish(ctx, account, content): Promise<PublishResult> {
    const token = await accessToken(ctx, account);
    const warnings: string[] = [];

    const { text, truncated } = composeCaption(content, {
      limit: this.capabilities.captionLimit,
      includeTopic: Boolean(content.topic && !content.description),
      hashtagLimit: 10,
    });
    if (truncated) {
      warnings.push(
        "Text exceeded 280 chars and was truncated. Pass a `thread` array to split it across posts instead.",
      );
    }

    const mediaIds: string[] = [];
    for (const item of content.media ?? []) {
      mediaIds.push(await uploadMedia(token, item));
    }

    const overrides = (content.platformOverrides?.x ?? {}) as Record<string, unknown>;
    const root = await createPost(token, {
      text: text || content.topic || "",
      ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
      ...overrides,
    });

    // Chain any thread entries as replies to the previous post.
    let previous = root.id;
    for (const entry of content.thread ?? []) {
      try {
        const next = await createPost(token, {
          text: entry.slice(0, 280),
          reply: { in_reply_to_tweet_id: previous },
        });
        previous = next.id;
      } catch (err) {
        warnings.push(`Thread stopped early: ${describeError(err)}`);
        break;
      }
    }

    if (content.firstComment) {
      try {
        await createPost(token, {
          text: content.firstComment.slice(0, 280),
          reply: { in_reply_to_tweet_id: previous },
        });
      } catch (err) {
        warnings.push(`First comment failed: ${describeError(err)}`);
      }
    }

    const user = await me(token).catch(() => undefined);
    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "published",
      postId: root.id,
      url: `https://x.com/${user?.username ?? "i"}/status/${root.id}`,
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async accountAnalytics(ctx, account, range: DateRange): Promise<AccountAnalytics> {
    const token = await accessToken(ctx, account);
    const user = await me(token);
    const totals: Record<string, number> = {
      followers: user.public_metrics?.followers_count ?? 0,
      following: user.public_metrics?.following_count ?? 0,
      posts: user.public_metrics?.tweet_count ?? 0,
    };
    const notes = [
      "X exposes no day-level account report on the standard API; range metrics are summed from posts published inside the window.",
    ];

    try {
      const posts = await this.listPosts(ctx, account, 100);
      const since = Date.parse(`${range.since}T00:00:00Z`);
      const until = Date.parse(`${range.until}T23:59:59Z`);
      const inRange = posts.filter((p) => {
        if (!p.publishedAt) return false;
        const at = Date.parse(p.publishedAt);
        return at >= since && at <= until;
      });
      totals.postsInRange = inRange.length;
      for (const key of ["impressions", "likes", "replies", "reposts", "quotes", "bookmarks"]) {
        totals[key] = inRange.reduce((sum, p) => sum + (p.metrics?.[key] ?? 0), 0);
      }
    } catch (err) {
      notes.push(`Could not summarize posts in range: ${describeError(err)}`);
    }

    return { accountId: account.id, platform: PLATFORM, range, totals, notes };
  },

  async postAnalytics(ctx, account, postId): Promise<PostAnalytics> {
    const token = await accessToken(ctx, account);
    const notes: string[] = [];

    // organic_metrics/non_public_metrics need elevated access; degrade cleanly.
    let res: any;
    try {
      res = await request<any>(`${BASE}/tweets/${postId}`, {
        platform: PLATFORM,
        headers: bearer(token),
        query: {
          "tweet.fields":
            "public_metrics,non_public_metrics,organic_metrics,created_at,text",
        },
      });
    } catch (err) {
      notes.push(
        `Private metrics unavailable (${describeError(err)}); falling back to public metrics.`,
      );
      res = await request<any>(`${BASE}/tweets/${postId}`, {
        platform: PLATFORM,
        headers: bearer(token),
        query: { "tweet.fields": "public_metrics,created_at,text" },
      });
    }

    const data = res.data ?? {};
    const pub = data.public_metrics ?? {};
    const organic = data.organic_metrics ?? {};
    const nonPublic = data.non_public_metrics ?? {};

    return {
      accountId: account.id,
      platform: PLATFORM,
      postId,
      url: `https://x.com/i/status/${postId}`,
      publishedAt: data.created_at,
      caption: data.text,
      metrics: {
        likes: pub.like_count ?? 0,
        replies: pub.reply_count ?? 0,
        reposts: pub.retweet_count ?? 0,
        quotes: pub.quote_count ?? 0,
        bookmarks: pub.bookmark_count ?? 0,
        impressions: pub.impression_count ?? organic.impression_count ?? 0,
        profileClicks: nonPublic.user_profile_clicks ?? organic.user_profile_clicks,
        linkClicks: nonPublic.url_link_clicks ?? organic.url_link_clicks,
      },
      notes: notes.length ? notes : undefined,
    };
  },

  async listPosts(ctx, account, limit): Promise<PostSummary[]> {
    const token = await accessToken(ctx, account);
    const user = await me(token);
    const res = await request<{ data?: any[] }>(`${BASE}/users/${user.id}/tweets`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: {
        max_results: Math.min(Math.max(limit, 5), 100),
        "tweet.fields": "public_metrics,created_at,text",
        exclude: "retweets,replies",
      },
    });

    return (res.data ?? []).map((t: any) => ({
      postId: t.id,
      url: `https://x.com/${user.username ?? "i"}/status/${t.id}`,
      publishedAt: t.created_at,
      caption: t.text,
      metrics: {
        likes: t.public_metrics?.like_count ?? 0,
        replies: t.public_metrics?.reply_count ?? 0,
        reposts: t.public_metrics?.retweet_count ?? 0,
        quotes: t.public_metrics?.quote_count ?? 0,
        impressions: t.public_metrics?.impression_count ?? 0,
        bookmarks: t.public_metrics?.bookmark_count ?? 0,
      },
    }));
  },

  async listComments(ctx, account, postId, limit): Promise<CommentItem[]> {
    const token = await accessToken(ctx, account);
    // Replies are found by searching the conversation the post started.
    const res = await request<{ data?: any[] }>(`${BASE}/tweets/search/recent`, {
      platform: PLATFORM,
      headers: bearer(token),
      query: {
        query: `conversation_id:${postId} -is:retweet`,
        max_results: Math.min(Math.max(limit, 10), 100),
        "tweet.fields": "created_at,public_metrics,author_id,in_reply_to_user_id",
      },
    });

    return (res.data ?? []).map((t: any) => ({
      id: t.id,
      author: t.author_id,
      text: t.text ?? "",
      createdAt: t.created_at,
      likeCount: t.public_metrics?.like_count,
      replyCount: t.public_metrics?.reply_count,
      parentId: postId,
    }));
  },

  async replyToComment(ctx, account, args) {
    const token = await accessToken(ctx, account);
    const target = args.commentId ?? args.postId;
    if (!target) throw new ValidationError("Provide either commentId or postId.");
    const res = await createPost(token, {
      text: args.text.slice(0, 280),
      reply: { in_reply_to_tweet_id: target },
    });
    return { id: res.id, url: `https://x.com/i/status/${res.id}` };
  },

  async deletePost(ctx, account, postId) {
    const token = await accessToken(ctx, account);
    await request(`${BASE}/tweets/${postId}`, {
      method: "DELETE",
      platform: PLATFORM,
      headers: bearer(token),
    });
  },
};
