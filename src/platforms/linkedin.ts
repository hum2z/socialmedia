import { promises as fs } from "node:fs";
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
  SeriesPoint,
  ValidationIssue,
} from "../types.js";
import { ApiError, ValidationError, describeError } from "../util/errors.js";
import { request } from "../util/http.js";
import { composeCaption } from "../util/media.js";
import { statMedia } from "../util/media.js";
import type { AdapterContext, Capabilities, PlatformAdapter } from "./base.js";

const PLATFORM = "linkedin" as const;
const BASE = "https://api.linkedin.com/rest";
const VERSION = process.env.LINKEDIN_VERSION ?? "202506";

function auth(account: Account) {
  const accessToken = credential(account, "accessToken", { required: true })!;
  const authorUrn = credential(account, "authorUrn", { required: true })!;
  if (!authorUrn.startsWith("urn:li:")) {
    throw new ValidationError(
      `LinkedIn authorUrn must look like "urn:li:organization:123" or "urn:li:person:abc"; got "${authorUrn}".`,
    );
  }
  return { accessToken, authorUrn };
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "linkedin-version": VERSION,
  "x-restli-protocol-version": "2.0.0",
});

const isOrg = (urn: string) => urn.includes(":organization:");

/** LinkedIn uploads are initialize → PUT bytes → reference the returned urn. */
async function uploadImage(
  token: string,
  owner: string,
  media: MediaInput,
): Promise<string> {
  const { path: filePath } = await statMedia(media);
  const init = await request<{
    value?: { uploadUrl?: string; image?: string };
  }>(`${BASE}/images?action=initializeUpload`, {
    method: "POST",
    platform: PLATFORM,
    headers: headers(token),
    body: { initializeUploadRequest: { owner } },
  });

  const uploadUrl = init.value?.uploadUrl;
  const imageUrn = init.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new ApiError("LinkedIn did not return an image upload URL.", {
      platform: PLATFORM,
    });
  }

  const bytes = await fs.readFile(filePath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`LinkedIn image upload failed: ${text.slice(0, 300)}`, {
      platform: PLATFORM,
      status: res.status,
    });
  }
  return imageUrn;
}

async function uploadVideo(
  token: string,
  owner: string,
  media: MediaInput,
): Promise<string> {
  const { size, path: filePath } = await statMedia(media);
  const init = await request<{
    value?: {
      video?: string;
      uploadInstructions?: Array<{
        uploadUrl: string;
        firstByte: number;
        lastByte: number;
      }>;
      uploadToken?: string;
    };
  }>(`${BASE}/videos?action=initializeUpload`, {
    method: "POST",
    platform: PLATFORM,
    headers: headers(token),
    body: {
      initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false },
    },
  });

  const videoUrn = init.value?.video;
  const instructions = init.value?.uploadInstructions ?? [];
  if (!videoUrn || !instructions.length) {
    throw new ApiError("LinkedIn did not return video upload instructions.", {
      platform: PLATFORM,
    });
  }

  // LinkedIn splits large videos into byte ranges and wants each part's ETag back.
  const etags: string[] = [];
  const handle = await fs.open(filePath, "r");
  try {
    for (const part of instructions) {
      const length = part.lastByte - part.firstByte + 1;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, part.firstByte);
      const res = await fetch(part.uploadUrl, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: new Uint8Array(buffer.subarray(0, bytesRead)),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ApiError(
          `LinkedIn video part upload failed: ${text.slice(0, 300)}`,
          { platform: PLATFORM, status: res.status },
        );
      }
      const etag = res.headers.get("etag");
      if (etag) etags.push(etag);
    }
  } finally {
    await handle.close();
  }

  await request(`${BASE}/videos?action=finalizeUpload`, {
    method: "POST",
    platform: PLATFORM,
    headers: headers(token),
    body: {
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: init.value?.uploadToken ?? "",
        uploadedPartIds: etags,
      },
    },
  });

  return videoUrn;
}

export const linkedinAdapter: PlatformAdapter = {
  platform: PLATFORM,

  capabilities: {
    captionLimit: 3000,
    media: { image: true, video: true, maxItems: 1, required: false },
    requiresPublicUrl: false,
    supportsThread: false,
    supportsFirstComment: true,
    supportsScheduling: false,
    supportsDelete: true,
    supportsReply: true,
    asyncPublish: false,
    maxHashtags: 10,
  } satisfies Capabilities,

  validate(content: PostContent): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if ((content.media?.length ?? 0) > 1) {
      issues.push({
        level: "warning",
        field: "media",
        message: "This server attaches a single image or video to a LinkedIn post; extra items are ignored.",
      });
    }
    return issues;
  },

  async verify(_ctx, account): Promise<AccountProfile> {
    const { accessToken, authorUrn } = auth(account);

    if (isOrg(authorUrn)) {
      const id = authorUrn.split(":").pop()!;
      const org = await request<{
        localizedName?: string;
        vanityName?: string;
      }>(`${BASE}/organizations/${id}`, {
        platform: PLATFORM,
        headers: headers(accessToken),
      });
      let followers: number | undefined;
      try {
        const stats = await request<{
          elements?: Array<{ firstDegreeSize?: number }>;
        }>(`${BASE}/networkSizes/${encodeURIComponent(authorUrn)}?edgeType=CompanyFollowedByMember`, {
          platform: PLATFORM,
          headers: headers(accessToken),
        });
        followers =
          (stats as any)?.firstDegreeSize ?? stats.elements?.[0]?.firstDegreeSize;
      } catch {
        /* follower count needs an extra scope; not fatal */
      }
      return {
        accountId: account.id,
        platform: PLATFORM,
        handle: org.vanityName ? `linkedin.com/company/${org.vanityName}` : account.handle,
        displayName: org.localizedName,
        followers,
      };
    }

    const profile = await request<{ name?: string; sub?: string }>(
      "https://api.linkedin.com/v2/userinfo",
      { platform: PLATFORM, headers: { authorization: `Bearer ${accessToken}` } },
    );
    return {
      accountId: account.id,
      platform: PLATFORM,
      handle: account.handle,
      displayName: profile.name,
    };
  },

  async publish(_ctx, account, content): Promise<PublishResult> {
    const { accessToken, authorUrn } = auth(account);
    const warnings: string[] = [];

    const { text: commentary, truncated } = composeCaption(content, {
      limit: this.capabilities.captionLimit,
      includeTopic: true,
      hashtagLimit: 10,
    });
    if (truncated) warnings.push("Commentary was truncated to LinkedIn's 3000-char limit.");

    const item = content.media?.[0];
    let mediaContent: Record<string, unknown> | undefined;
    if (item) {
      const urn =
        item.kind === "video"
          ? await uploadVideo(accessToken, authorUrn, item)
          : await uploadImage(accessToken, authorUrn, item);
      mediaContent = {
        media: { id: urn, ...(item.altText ? { altText: item.altText } : {}) },
      };
    }

    const overrides = (content.platformOverrides?.linkedin ?? {}) as Record<string, unknown>;
    const res = await request<unknown>(`${BASE}/posts`, {
      method: "POST",
      platform: PLATFORM,
      headers: headers(accessToken),
      rawResponse: true,
      body: {
        author: authorUrn,
        commentary,
        visibility: content.privacy === "private" ? "CONNECTIONS" : "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(mediaContent ? { content: mediaContent } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...overrides,
      },
    });

    // The post urn comes back in a header, not the body.
    const postUrn =
      (res as Response).headers?.get("x-restli-id") ??
      (res as Response).headers?.get("x-linkedin-id");
    if (!postUrn) {
      throw new ApiError("LinkedIn published the post but returned no id header.", {
        platform: PLATFORM,
      });
    }

    if (content.firstComment) {
      try {
        await request(`${BASE}/socialActions/${encodeURIComponent(postUrn)}/comments`, {
          method: "POST",
          platform: PLATFORM,
          headers: headers(accessToken),
          body: { actor: authorUrn, message: { text: content.firstComment } },
        });
      } catch (err) {
        warnings.push(`First comment failed: ${describeError(err)}`);
      }
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      status: "published",
      postId: postUrn,
      url: `https://www.linkedin.com/feed/update/${postUrn}/`,
      warnings: warnings.length ? warnings : undefined,
    };
  },

  async accountAnalytics(_ctx, account, range: DateRange): Promise<AccountAnalytics> {
    const { accessToken, authorUrn } = auth(account);
    if (!isOrg(authorUrn)) {
      return {
        accountId: account.id,
        platform: PLATFORM,
        range,
        totals: {},
        notes: [
          "LinkedIn exposes share statistics for company pages only. A personal profile (urn:li:person:…) has no analytics API — use post_analytics per post instead.",
        ],
      };
    }

    const res = await request<{
      elements?: Array<{
        totalShareStatistics?: Record<string, number>;
        timeRange?: { start: number; end: number };
      }>;
    }>(`${BASE}/organizationalEntityShareStatistics`, {
      platform: PLATFORM,
      headers: headers(accessToken),
      query: {
        q: "organizationalEntity",
        organizationalEntity: authorUrn,
        "timeIntervals.timeGranularityType": "DAY",
        "timeIntervals.timeRange.start": Date.parse(`${range.since}T00:00:00Z`),
        "timeIntervals.timeRange.end": Date.parse(`${range.until}T23:59:59Z`),
      },
    });

    const totals: Record<string, number> = {};
    const series: SeriesPoint[] = [];
    for (const element of res.elements ?? []) {
      const stats = element.totalShareStatistics ?? {};
      const date = element.timeRange?.start
        ? new Date(element.timeRange.start).toISOString().slice(0, 10)
        : undefined;
      const row: Record<string, number> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (typeof value !== "number") continue;
        row[key] = value;
        totals[key] = (totals[key] ?? 0) + value;
      }
      if (date) series.push({ date, ...row });
    }

    return { accountId: account.id, platform: PLATFORM, range, totals, series };
  },

  async postAnalytics(_ctx, account, postId): Promise<PostAnalytics> {
    const { accessToken, authorUrn } = auth(account);
    const metrics: Record<string, number> = {};
    const notes: string[] = [];

    try {
      const social = await request<{
        likesSummary?: { totalLikes?: number };
        commentsSummary?: { totalFirstLevelComments?: number };
      }>(`${BASE}/socialActions/${encodeURIComponent(postId)}`, {
        platform: PLATFORM,
        headers: headers(accessToken),
      });
      metrics.likes = social.likesSummary?.totalLikes ?? 0;
      metrics.comments = social.commentsSummary?.totalFirstLevelComments ?? 0;
    } catch (err) {
      notes.push(`Social counts unavailable: ${describeError(err)}`);
    }

    if (isOrg(authorUrn)) {
      try {
        const stats = await request<{
          elements?: Array<{ totalShareStatistics?: Record<string, number> }>;
        }>(`${BASE}/organizationalEntityShareStatistics`, {
          platform: PLATFORM,
          headers: headers(accessToken),
          query: {
            q: "organizationalEntity",
            organizationalEntity: authorUrn,
            "shares[0]": postId,
          },
        });
        const share = stats.elements?.[0]?.totalShareStatistics ?? {};
        for (const [key, value] of Object.entries(share)) {
          if (typeof value === "number") metrics[key] = value;
        }
      } catch (err) {
        notes.push(`Share statistics unavailable: ${describeError(err)}`);
      }
    }

    return {
      accountId: account.id,
      platform: PLATFORM,
      postId,
      url: `https://www.linkedin.com/feed/update/${postId}/`,
      metrics,
      notes: notes.length ? notes : undefined,
    };
  },

  async listPosts(_ctx, account, limit): Promise<PostSummary[]> {
    const { accessToken, authorUrn } = auth(account);
    const res = await request<{
      elements?: Array<{
        id?: string;
        commentary?: string;
        createdAt?: number;
      }>;
    }>(`${BASE}/posts`, {
      platform: PLATFORM,
      headers: headers(accessToken),
      query: { q: "author", author: authorUrn, count: Math.min(limit, 50) },
    });

    return (res.elements ?? []).map((p) => ({
      postId: p.id ?? "",
      url: p.id ? `https://www.linkedin.com/feed/update/${p.id}/` : undefined,
      publishedAt: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
      caption: p.commentary,
    }));
  },

  async listComments(_ctx, account, postId, limit): Promise<CommentItem[]> {
    const { accessToken } = auth(account);
    const res = await request<{
      elements?: Array<{
        id?: string;
        actor?: string;
        message?: { text?: string };
        created?: { time?: number };
        likesSummary?: { totalLikes?: number };
      }>;
    }>(`${BASE}/socialActions/${encodeURIComponent(postId)}/comments`, {
      platform: PLATFORM,
      headers: headers(accessToken),
      query: { count: Math.min(limit, 50) },
    });

    return (res.elements ?? []).map((c) => ({
      id: c.id ?? "",
      author: c.actor,
      text: c.message?.text ?? "",
      createdAt: c.created?.time ? new Date(c.created.time).toISOString() : undefined,
      likeCount: c.likesSummary?.totalLikes,
    }));
  },

  async replyToComment(_ctx, account, args) {
    const { accessToken, authorUrn } = auth(account);
    const target = args.postId ?? args.commentId;
    if (!target) throw new ValidationError("Provide either postId or commentId.");
    const res = await request<{ id?: string }>(
      `${BASE}/socialActions/${encodeURIComponent(target)}/comments`,
      {
        method: "POST",
        platform: PLATFORM,
        headers: headers(accessToken),
        body: {
          actor: authorUrn,
          message: { text: args.text },
          ...(args.commentId && args.postId ? { parentComment: args.commentId } : {}),
        },
      },
    );
    return { id: res.id ?? "" };
  },

  async deletePost(_ctx, account, postId) {
    const { accessToken } = auth(account);
    await request(`${BASE}/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      platform: PLATFORM,
      headers: headers(accessToken),
    });
  },
};
