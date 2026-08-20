/**
 * Adapter tests. These run the real adapter code — the same functions the MCP
 * tools call — against a stubbed `fetch` that speaks each platform's actual
 * protocol back at it.
 *
 * That verifies everything up to the network boundary: URLs, request shapes,
 * multi-step flows, chunk arithmetic, token refresh, header handling and
 * response parsing. What it cannot prove is that the live platform accepts the
 * request; only real credentials do that.
 *
 *   npm run build && node test/adapters.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workdir = await mkdtemp(path.join(tmpdir(), "social-mcp-adapters-"));

let failures = 0;
let current = "";
const section = (name) => console.log(`\n${name}`);
const check = (label, condition, detail = "") => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** Every request the adapter under test made, in order. */
let calls = [];
const record = (method, url, init) => {
  calls.push({ method, url, init, path: new URL(url).pathname });
};
const find = (fragment, method) =>
  calls.filter(
    (c) => c.url.includes(fragment) && (!method || c.method === method),
  );
const bodyOf = (call) => {
  const body = call.init?.body;
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Routes are [method, url-fragment, handler]; first match wins. */
let routes = [];
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const href = String(url);
  record(method, href, init);
  for (const [m, fragment, handler] of routes) {
    if (m === method && href.includes(fragment)) {
      return handler(href, init);
    }
  }
  return json({ error: { message: `unrouted ${method} ${href}` } }, 500);
};

const sessions = [];
const ctx = {
  saveSession: async (accountId, session) => {
    sessions.push({ accountId, session });
  },
};

const reset = (newRoutes) => {
  calls = [];
  sessions.length = 0;
  routes = newRoutes;
};

// Real files, so chunk reads and size arithmetic are exercised for real.
const videoPath = path.join(workdir, "clip.mp4");
const imagePath = path.join(workdir, "shot.jpg");
const thumbPath = path.join(workdir, "thumb.jpg");
const VIDEO_SIZE = 25 * 1024 * 1024 + 12345; // deliberately not chunk-aligned
await writeFile(videoPath, Buffer.alloc(VIDEO_SIZE, 7));
await writeFile(imagePath, Buffer.alloc(512 * 1024, 3));
await writeFile(thumbPath, Buffer.alloc(1024, 1));

const { instagramAdapter } = await import("../dist/platforms/instagram.js");
const { youtubeAdapter } = await import("../dist/platforms/youtube.js");
const { tiktokAdapter } = await import("../dist/platforms/tiktok.js");
const { xAdapter } = await import("../dist/platforms/x.js");
const { linkedinAdapter } = await import("../dist/platforms/linkedin.js");

const account = (over) => ({ enabled: true, credentials: {}, ...over });

try {
  // ─────────────────────────────────────────────────────────── Instagram ────
  section("instagram · single image");
  {
    const ig = account({
      id: "ig_main",
      platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "IG_TOKEN" },
    });
    reset([
      ["POST", "/1784100/media_publish", () => json({ id: "media_99" })],
      ["POST", "/1784100/media", () => json({ id: "container_1" })],
      ["GET", "container_1", () => json({ status_code: "FINISHED" })],
      ["POST", "/media_99/comments", () => json({ id: "comment_1" })],
      ["GET", "/media_99", () => json({ permalink: "https://instagram.com/p/abc" })],
    ]);

    const result = await instagramAdapter.publish(ctx, ig, {
      topic: "Spring drop",
      description: "The new collection is live.",
      hashtags: ["spring", "drop"],
      media: [{ kind: "image", url: "https://cdn.example.com/a.jpg" }],
      firstComment: "Link in bio",
    });

    const create = find("/1784100/media", "POST")[0];
    const form = bodyOf(create);
    check("creates a container before publishing", Boolean(create));
    check("sends image_url", form?.image_url === "https://cdn.example.com/a.jpg");
    check("caption merges topic, body and hashtags",
      form?.caption === "Spring drop\n\nThe new collection is live.\n\n#spring #drop",
      JSON.stringify(form?.caption));
    check("polls container status before publish", find("container_1", "GET").length === 1);
    check("publishes the container",
      bodyOf(find("media_publish", "POST")[0])?.creation_id === "container_1");
    check("posts the first comment", find("/media_99/comments", "POST").length === 1);
    check("returns the published media id", result.postId === "media_99");
    check("returns the permalink", result.url === "https://instagram.com/p/abc");
    check("reports status published", result.status === "published");
  }

  section("instagram · reels and carousel");
  {
    const ig = account({
      id: "ig_main", platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "IG_TOKEN" },
    });
    reset([
      ["POST", "/1784100/media_publish", () => json({ id: "media_1" })],
      ["POST", "/1784100/media", () => json({ id: `c_${calls.length}` })],
      ["GET", "/c_", () => json({ status_code: "FINISHED" })],
      ["GET", "/media_1", () => json({ permalink: "p" })],
    ]);
    await instagramAdapter.publish(ctx, ig, {
      description: "reel",
      media: [{ kind: "video", url: "https://cdn.example.com/v.mp4" }],
    });
    check("a single video posts as REELS",
      bodyOf(find("/1784100/media", "POST")[0])?.media_type === "REELS");

    reset([
      ["POST", "/1784100/media_publish", () => json({ id: "media_2" })],
      ["POST", "/1784100/media", (u, i) => json({ id: `child_${find("/1784100/media", "POST").length}` })],
      ["GET", "/child_", () => json({ status_code: "FINISHED" })],
      ["GET", "/media_2", () => json({ permalink: "p" })],
    ]);
    await instagramAdapter.publish(ctx, ig, {
      description: "carousel",
      media: [
        { kind: "image", url: "https://cdn.example.com/1.jpg" },
        { kind: "image", url: "https://cdn.example.com/2.jpg" },
        { kind: "image", url: "https://cdn.example.com/3.jpg" },
      ],
    });
    const creates = find("/1784100/media", "POST").map(bodyOf);
    const children = creates.filter((b) => b.is_carousel_item === "true");
    const parent = creates.find((b) => b.media_type === "CAROUSEL");
    check("builds one child container per item", children.length === 3, `got ${children.length}`);
    check("builds a CAROUSEL parent", Boolean(parent));
    check("parent references every child", parent?.children.split(",").length === 3);
  }

  section("instagram · failures surface, not silently pass");
  {
    const ig = account({
      id: "ig_main", platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "IG_TOKEN" },
    });
    reset([
      ["POST", "/1784100/media", () => json({ id: "bad_container" })],
      ["GET", "bad_container", () => json({ status_code: "ERROR", status: "codec unsupported" })],
    ]);
    let threw;
    try {
      await instagramAdapter.publish(ctx, ig, {
        description: "x", media: [{ kind: "video", url: "https://cdn.example.com/v.mp4" }],
      });
    } catch (err) { threw = err; }
    check("a container ERROR aborts the publish", Boolean(threw));
    check("the error names the real cause",
      threw?.message.includes("codec unsupported"), threw?.message);
    check("nothing was published", find("media_publish").length === 0);
  }

  section("instagram · insights and quota");
  {
    const ig = account({
      id: "ig_main", platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "IG_TOKEN" },
    });
    reset([
      ["GET", "content_publishing_limit", () =>
        json({ data: [{ quota_usage: 3, config: { quota_total: 50 } }] })],
      ["GET", "/insights", (href) => {
        if (href.includes("total_value"))
          return json({ data: [{ name: "likes", total_value: { value: 120 } }] });
        return json({ data: [{ name: "reach", values: [
          { value: 10, end_time: "2026-08-01T07:00:00+0000" },
          { value: 15, end_time: "2026-08-02T07:00:00+0000" }] }] });
      }],
      ["GET", "/1784100", () => json({
        id: "1784100", username: "brand", name: "Brand",
        followers_count: 24310, media_count: 87 })],
    ]);

    const profile = await instagramAdapter.verify(ctx, ig);
    check("verify returns the handle", profile.handle === "@brand");
    check("verify returns followers", profile.followers === 24310);
    check("verify computes remaining publish quota", profile.quotaRemaining === 47);

    const stats = await instagramAdapter.accountAnalytics(ctx, ig,
      { since: "2026-08-01", until: "2026-08-02" });
    check("day metrics are summed", stats.totals.reach === 25);
    check("total_value metrics are read", stats.totals.likes === 120);
    check("a per-day series is built", stats.series.length === 2);
    check("series rows carry the date", stats.series[0].date === "2026-08-01");
  }

  section("instagram · degrades when insights are unavailable");
  {
    const ig = account({
      id: "ig_main", platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "IG_TOKEN" },
    });
    reset([
      ["GET", "/insights", () =>
        json({ error: { message: "metric deprecated" } }, 400)],
      ["GET", "/1784100", () => json({ followers_count: 100 })],
    ]);
    const stats = await instagramAdapter.accountAnalytics(ctx, ig,
      { since: "2026-08-01", until: "2026-08-02" });
    check("a failed metric family does not throw", Boolean(stats));
    check("the follower count still comes through", stats.totals.followers === 100);
    check("the gap is explained in notes",
      stats.notes.some((n) => n.includes("metric deprecated")), JSON.stringify(stats.notes));
  }

  // ───────────────────────────────────────────────────────────── YouTube ────
  section("youtube · token refresh and resumable upload");
  {
    const yt = account({
      id: "yt_main", platform: "youtube",
      credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "REFRESH" },
    });
    const uploadUrl = "https://upload.example.com/session/xyz";
    let received = 0;
    const ranges = [];
    reset([
      ["POST", "oauth2.googleapis.com/token", () =>
        json({ access_token: "AT_1", expires_in: 3600 })],
      ["POST", "/upload/youtube/v3/videos", () =>
        new Response("", { status: 200, headers: { location: uploadUrl } })],
      ["PUT", uploadUrl, (href, init) => {
        const range = init.headers["content-range"];
        ranges.push(range);
        const [, , end, total] = range.match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
        received = end + 1;
        if (received >= VIDEO_SIZE) return json({ id: "vid_123" });
        return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
      }],
      ["POST", "/upload/youtube/v3/thumbnails/set", () => json({ ok: true })],
      ["POST", "/youtube/v3/commentThreads", () => json({ id: "ct_1" })],
    ]);

    const result = await youtubeAdapter.publish(ctx, yt, {
      topic: "How we built it",
      description: "Full walkthrough.",
      hashtags: ["build"],
      media: [{ kind: "video", path: videoPath, thumbnailPath: thumbPath }],
      firstComment: "Chapters below",
    });

    const refresh = bodyOf(find("oauth2.googleapis.com/token")[0]);
    check("exchanges the refresh token", refresh?.grant_type === "refresh_token");
    check("caches the new access token", sessions[0]?.session.accessToken === "AT_1");
    const init = bodyOf(find("/upload/youtube/v3/videos", "POST")[0]);
    check("sends the title", init?.snippet.title === "How we built it");
    check("sends tags", init?.snippet.tags[0] === "build");
    check("defaults to public", init?.status.privacyStatus === "public");
    check("uploads every byte exactly once", received === VIDEO_SIZE,
      `${received} of ${VIDEO_SIZE}`);
    check("chunks are contiguous and 8MiB", ranges.length === 4, ranges.join(" "));
    check("the first range starts at 0", ranges[0] === `bytes 0-8388607/${VIDEO_SIZE}`);
    check("the last range ends at the final byte",
      ranges.at(-1) === `bytes 25165824-${VIDEO_SIZE - 1}/${VIDEO_SIZE}`);
    check("sets the custom thumbnail", find("thumbnails/set").length === 1);
    check("posts the first comment", find("commentThreads", "POST").length === 1);
    check("returns the video id", result.postId === "vid_123");
    check("returns a watch URL", result.url === "https://www.youtube.com/watch?v=vid_123");
  }

  section("youtube · scheduling");
  {
    const yt = account({
      id: "yt_main", platform: "youtube",
      credentials: { clientId: "c", clientSecret: "s", refreshToken: "R" },
      session: { accessToken: "AT", expiresAt: Date.now() + 3_600_000 },
    });
    const uploadUrl = "https://upload.example.com/s2";
    reset([
      ["POST", "/upload/youtube/v3/videos", () =>
        new Response("", { status: 200, headers: { location: uploadUrl } })],
      ["PUT", uploadUrl, () => json({ id: "vid_sched" })],
    ]);
    const result = await youtubeAdapter.publish(ctx, yt, {
      topic: "Later", media: [{ kind: "video", path: imagePath }],
      scheduledAt: "2026-09-01T15:00:00Z",
    });
    const init = bodyOf(find("/upload/youtube/v3/videos", "POST")[0]);
    check("a scheduled upload is private until publishAt",
      init?.status.privacyStatus === "private");
    check("publishAt is sent as ISO-8601",
      init?.status.publishAt === "2026-09-01T15:00:00.000Z");
    check("status is reported as scheduled", result.status === "scheduled");
    check("a cached access token skips the refresh call",
      find("oauth2.googleapis.com").length === 0);
  }

  section("youtube · analytics");
  {
    const yt = account({
      id: "yt_main", platform: "youtube",
      credentials: { clientId: "c", clientSecret: "s", refreshToken: "R" },
      session: { accessToken: "AT", expiresAt: Date.now() + 3_600_000 },
    });
    reset([
      ["GET", "youtubeanalytics.googleapis.com", () => json({
        columnHeaders: [
          { name: "day" }, { name: "views" }, { name: "likes" },
          { name: "averageViewDuration" },
          { name: "subscribersGained" }, { name: "subscribersLost" }],
        rows: [
          ["2026-08-01", 100, 10, 120, 5, 1],
          ["2026-08-02", 200, 20, 180, 7, 2]],
      })],
    ]);
    const stats = await youtubeAdapter.accountAnalytics(ctx, yt,
      { since: "2026-08-01", until: "2026-08-02" });
    check("views are summed", stats.totals.views === 300);
    check("averageViewDuration is averaged, not summed",
      stats.totals.averageViewDuration === 150, String(stats.totals.averageViewDuration));
    check("net subscribers are computed", stats.totals.netSubscribers === 9);
    check("the day series is preserved", stats.series.length === 2);
  }

  // ────────────────────────────────────────────────────────────── TikTok ────
  section("tiktok · chunked upload and async publish");
  {
    const tt = account({
      id: "tt_main", platform: "tiktok",
      credentials: { clientKey: "k", clientSecret: "s", refreshToken: "OLD_REFRESH" },
    });
    const uploadUrl = "https://upload.tiktok.example/u1";
    const ranges = [];
    reset([
      ["POST", "/v2/oauth/token/", () => json({
        access_token: "TT_AT", expires_in: 86400, refresh_token: "NEW_REFRESH" })],
      ["POST", "creator_info/query", () => json({ data: {
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
        comment_disabled: false, duet_disabled: false, stitch_disabled: false } })],
      ["POST", "/video/init/", () => json({ data: {
        publish_id: "pub_1", upload_url: uploadUrl } })],
      ["PUT", uploadUrl, (href, init) => {
        ranges.push(init.headers["content-range"]);
        return new Response(null, { status: 200 });
      }],
      ["POST", "status/fetch", () => json({ data: {
        status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7300"] } })],
    ]);

    const result = await tiktokAdapter.publish(ctx, tt, {
      topic: "Behind the scenes",
      description: "How it is made.",
      media: [{ kind: "video", path: videoPath }],
    });

    check("rotated refresh token is persisted",
      sessions[0]?.session.refreshToken === "NEW_REFRESH");
    check("queries creator_info before posting",
      find("creator_info/query").length === 1);
    const init = bodyOf(find("/video/init/", "POST")[0]);
    check("requests the public privacy level",
      init?.post_info.privacy_level === "PUBLIC_TO_EVERYONE");
    check("declares the true file size", init?.source_info.video_size === VIDEO_SIZE);
    const chunkSize = init?.source_info.chunk_size;
    const chunkCount = init?.source_info.total_chunk_count;
    check("chunk size is within TikTok's 5–64MiB window",
      chunkSize >= 5 * 1024 * 1024 && chunkSize <= 64 * 1024 * 1024, String(chunkSize));
    check("chunk count matches floor(size/chunkSize)",
      chunkCount === Math.floor(VIDEO_SIZE / chunkSize), `${chunkCount}`);
    check("uploads exactly total_chunk_count chunks",
      ranges.length === chunkCount, `${ranges.length} vs ${chunkCount}`);
    check("the last chunk absorbs the remainder",
      ranges.at(-1) === `bytes ${chunkSize * (chunkCount - 1)}-${VIDEO_SIZE - 1}/${VIDEO_SIZE}`,
      ranges.at(-1));
    check("publish returns processing, not published", result.status === "processing");
    check("publish returns a pollable jobRef", result.jobRef === "pub_1");

    const status = await tiktokAdapter.publishStatus(ctx, tt, "pub_1");
    check("status poll reports published", status.status === "published");
    check("status poll reads TikTok's misspelled id field", status.postId === "7300");
  }

  section("tiktok · unaudited app is forced private, and says so");
  {
    const tt = account({
      id: "tt_main", platform: "tiktok",
      credentials: { clientKey: "k", clientSecret: "s", refreshToken: "R" },
      session: { accessToken: "AT", expiresAt: Date.now() + 3_600_000 },
    });
    reset([
      ["POST", "creator_info/query", () =>
        json({ data: { privacy_level_options: ["SELF_ONLY"] } })],
      ["POST", "/video/init/", () => json({ data: { publish_id: "p2" } })],
    ]);
    const result = await tiktokAdapter.publish(ctx, tt, {
      description: "hi", media: [{ kind: "video", url: "https://cdn.example.com/v.mp4" }],
    });
    check("falls back to SELF_ONLY",
      bodyOf(find("/video/init/", "POST")[0])?.post_info.privacy_level === "SELF_ONLY");
    check("warns the user the post is private",
      result.warnings?.some((w) => w.includes("SELF_ONLY")), JSON.stringify(result.warnings));
    check("a public URL skips the chunk upload entirely",
      bodyOf(find("/video/init/", "POST")[0])?.source_info.source === "PULL_FROM_URL");
  }

  // ─────────────────────────────────────────────────────────────────── X ────
  section("x · media upload, post and thread");
  {
    const x = account({
      id: "x_main", platform: "x",
      credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "R" },
    });
    let tweetSeq = 0;
    reset([
      ["POST", "/oauth2/token", () =>
        json({ access_token: "X_AT", expires_in: 7200, refresh_token: "X_R2" })],
      ["POST", "/media/upload/initialize", () => json({ data: { id: "media_1" } })],
      ["POST", "/media/upload/media_1/append", () => json({ data: {} })],
      ["POST", "/media/upload/media_1/finalize", () => json({ data: { id: "media_1" } })],
      ["POST", "/media/metadata", () => json({ data: {} })],
      ["POST", "/2/tweets", () => json({ data: { id: `tweet_${++tweetSeq}` } })],
      ["GET", "/users/me", () => json({ data: {
        id: "u1", username: "brand", name: "Brand",
        public_metrics: { followers_count: 900 } } })],
    ]);

    const result = await xAdapter.publish(ctx, x, {
      description: "Shipping today.",
      hashtags: ["ship"],
      media: [{ kind: "image", path: imagePath, altText: "a screenshot" }],
      thread: ["Second post in the thread.", "Third post."],
      firstComment: "Docs here",
    });

    const basic = find("/oauth2/token")[0]?.init.headers.authorization;
    check("confidential client refreshes with HTTP Basic",
      basic?.startsWith("Basic "), basic);
    check("uses INIT/APPEND/FINALIZE for media",
      find("initialize").length === 1 && find("append").length === 1 &&
      find("finalize").length === 1);
    check("sets alt text on the media", find("/media/metadata").length === 1);
    const posts = find("/2/tweets", "POST").map(bodyOf);
    check("attaches the uploaded media", posts[0]?.media.media_ids[0] === "media_1");
    check("root text carries the hashtag",
      posts[0]?.text === "Shipping today.\n\n#ship", JSON.stringify(posts[0]?.text));
    check("posts 1 root + 2 thread + 1 comment", posts.length === 4, `${posts.length}`);
    check("thread entry 1 replies to the root",
      posts[1]?.reply.in_reply_to_tweet_id === "tweet_1");
    check("thread entry 2 replies to entry 1",
      posts[2]?.reply.in_reply_to_tweet_id === "tweet_2");
    check("the first comment lands at the end of the thread",
      posts[3]?.reply.in_reply_to_tweet_id === "tweet_3");
    check("returns a URL with the real handle",
      result.url === "https://x.com/brand/status/tweet_1", result.url);
  }

  section("x · long text truncates on a word boundary and warns");
  {
    const x = account({
      id: "x_main", platform: "x", credentials: { clientId: "c", refreshToken: "R" },
      session: { accessToken: "AT", expiresAt: Date.now() + 3_600_000 },
    });
    reset([
      ["POST", "/2/tweets", () => json({ data: { id: "t1" } })],
      ["GET", "/users/me", () => json({ data: { id: "u", username: "brand" } })],
    ]);
    const long = "word ".repeat(80).trim();
    const result = await xAdapter.publish(ctx, x, { description: long });
    const text = bodyOf(find("/2/tweets", "POST")[0])?.text;
    check("truncated to the 280 limit", text.length <= 280, `${text.length}`);
    check("cut on a word boundary, not mid-word", /(word|…)$/.test(text), text);
    check("the user is warned about truncation",
      result.warnings?.some((w) => w.includes("280")));
  }

  section("x · falls back when private metrics are gated");
  {
    const x = account({
      id: "x_main", platform: "x", credentials: { clientId: "c", refreshToken: "R" },
      session: { accessToken: "AT", expiresAt: Date.now() + 3_600_000 },
    });
    reset([
      ["GET", "/tweets/t9", (href) => {
        if (href.includes("non_public_metrics"))
          return json({ error: { message: "insufficient access level" } }, 403);
        return json({ data: {
          id: "t9", text: "hi", created_at: "2026-08-01T00:00:00Z",
          public_metrics: { like_count: 5, impression_count: 900 } } });
      }],
    ]);
    const stats = await xAdapter.postAnalytics(ctx, x, "t9");
    check("retries without the gated fields", find("/tweets/t9").length === 2);
    check("public metrics still come through", stats.metrics.likes === 5);
    check("impressions still come through", stats.metrics.impressions === 900);
    check("the gap is explained in notes",
      stats.notes?.some((n) => n.includes("Private metrics unavailable")));
  }

  // ──────────────────────────────────────────────────────────── LinkedIn ────
  section("linkedin · image upload and post");
  {
    const li = account({
      id: "li_page", platform: "linkedin",
      credentials: { accessToken: "LI_AT", authorUrn: "urn:li:organization:123" },
    });
    const uploadUrl = "https://li-upload.example/u";
    reset([
      ["POST", "/images?action=initializeUpload", () => json({ value: {
        uploadUrl, image: "urn:li:image:img1" } })],
      ["PUT", uploadUrl, () => new Response(null, { status: 201 })],
      ["POST", "/rest/posts", () =>
        new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:987" } })],
      ["POST", "/socialActions/", () => json({ id: "c1" })],
    ]);

    const result = await linkedinAdapter.publish(ctx, li, {
      topic: "We are hiring",
      description: "Three roles open.",
      media: [{ kind: "image", path: imagePath, altText: "team photo" }],
      firstComment: "Apply here",
    });

    const post = bodyOf(find("/rest/posts", "POST")[0]);
    check("initializes the image upload before posting",
      find("initializeUpload").length === 1);
    check("PUTs the image bytes", find(uploadUrl, "PUT").length === 1);
    check("references the returned image URN",
      post?.content.media.id === "urn:li:image:img1");
    check("sends the alt text", post?.content.media.altText === "team photo");
    check("author is the configured URN", post?.author === "urn:li:organization:123");
    check("commentary merges topic and body",
      post?.commentary === "We are hiring\n\nThree roles open.");
    check("visibility defaults to PUBLIC", post?.visibility === "PUBLIC");
    check("reads the post id from the x-restli-id header",
      result.postId === "urn:li:share:987");
    check("posts the first comment", find("/socialActions/", "POST").length === 1);
    check("sends the LinkedIn-Version header",
      Boolean(find("/rest/posts", "POST")[0].init.headers["linkedin-version"]));
  }

  section("linkedin · personal profiles have no analytics API");
  {
    const li = account({
      id: "li_me", platform: "linkedin",
      credentials: { accessToken: "AT", authorUrn: "urn:li:person:abc" },
    });
    reset([]);
    const stats = await linkedinAdapter.accountAnalytics(ctx, li,
      { since: "2026-08-01", until: "2026-08-28" });
    check("returns no invented numbers", Object.keys(stats.totals).length === 0);
    check("explains why it is empty",
      stats.notes[0].includes("company pages only"), stats.notes[0]);
    check("makes no pointless API call", calls.length === 0);
  }

  // ─────────────────────────────────────────────────── shared HTTP layer ────
  section("http layer · retries, rate limits and error messages");
  {
    const ig = account({
      id: "ig_main", platform: "instagram",
      credentials: { igUserId: "1784100", accessToken: "T" },
    });

    let attempts = 0;
    // The quota URL also contains "/1784100", so it must be routed first.
    reset([
      ["GET", "content_publishing_limit", () => json({ data: [] })],
      ["GET", "/1784100", () => {
        attempts++;
        if (attempts < 3) return json({ error: { message: "busy" } }, 503);
        return json({ id: "1784100", username: "brand" });
      }],
    ]);
    const profile = await instagramAdapter.verify(ctx, ig);
    check("retries a 503 and eventually succeeds", profile.handle === "@brand");
    check("used three attempts", attempts === 3, String(attempts));

    reset([
      ["GET", "content_publishing_limit", () => json({ data: [] })],
      ["GET", "/1784100", () =>
        json({ error: { message: "Session has expired" } }, 401)],
    ]);
    let authErr;
    try { await instagramAdapter.verify(ctx, ig); } catch (e) { authErr = e; }
    check("a 401 is not retried into a loop", find("/1784100").length === 1);
    check("the 401 message keeps the platform's own text",
      authErr?.message.includes("Session has expired"), authErr?.message);
    check("the 401 message says what to do",
      authErr?.message.includes("re-authorize"), authErr?.message);

    const started = Date.now();
    reset([
      ["GET", "content_publishing_limit", () => json({ data: [] })],
      ["GET", "/1784100", () =>
        json({ error: { message: "rate limited" } }, 429,
          { "retry-after": "1" })],
    ]);
    let rateErr;
    try { await instagramAdapter.verify(ctx, ig); } catch (e) { rateErr = e; }
    check("a 429 is retried", find("/1784100").length === 3);
    check("Retry-After is honored", Date.now() - started >= 2000,
      `${Date.now() - started}ms`);
    check("the 429 message mentions rate limiting",
      rateErr?.message.includes("Rate limited"), rateErr?.message);
  }

  section("credentials · missing secrets fail loudly");
  {
    const { credential } = await import("../dist/config.js");
    const acct = account({
      id: "ig_x", platform: "instagram",
      credentials: { igUserId: "1", accessToken: "env:DEFINITELY_NOT_SET_12345" },
    });
    let err;
    try { credential(acct, "accessToken", { required: true }); } catch (e) { err = e; }
    check("a missing env credential throws", Boolean(err));
    check("the message names the variable to set",
      err?.message.includes("DEFINITELY_NOT_SET_12345"), err?.message);

    process.env.SOCIAL_TEST_TOKEN = "resolved-value";
    const acct2 = account({
      id: "ig_y", platform: "instagram",
      credentials: { accessToken: "env:SOCIAL_TEST_TOKEN" },
    });
    check("env: indirection resolves from the environment",
      credential(acct2, "accessToken") === "resolved-value");
    const acct3 = account({ id: "z", platform: "x", credentials: { accessToken: "literal" } });
    check("a literal credential passes through unchanged",
      credential(acct3, "accessToken") === "literal");
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : `\nAll adapter checks passed`);
process.exit(failures ? 1 : 0);
