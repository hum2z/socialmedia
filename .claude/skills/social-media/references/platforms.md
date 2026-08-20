# Platform reference

Hard limits the server enforces, plus the quirks that cause most failures.
`platform_capabilities` returns the machine-readable version of this table.

## Instagram

| | |
|---|---|
| Caption | 2,200 chars |
| Media | Required — 1 item, or 2–10 for a carousel |
| Source | **Public URL only.** A local path cannot be uploaded |
| Hashtags | 30 max, counted inside the caption |
| Publish | Asynchronous container flow |
| Delete | Not supported by the API |

- Account must be **Business or Creator**, not personal.
- Single videos post as **Reels**; there is no separate feed-video type any more.
- Video: MP4/MOV, H.264 + AAC, 3s–15min, aspect ratio 0.01:1 to 10:1 (9:16 for
  Reels). Images: JPEG, 8MB max, 4:5 to 1.91:1.
- 50 posts per rolling 24 hours. `check_account` reports what is left.
- Carousels build each child container first, then a parent — slower than a
  single post, and any one bad child fails the whole thing.
- The API cannot delete media. Deletion happens in the app.

## YouTube

| | |
|---|---|
| Title | 100 chars (hard error above) |
| Description | 5,000 chars |
| Media | Exactly one video, **local path required** |
| Tags | 15 used from `hashtags` |
| Scheduling | Native, via `scheduledAt` |
| Delete | Supported |

- Uploads are resumable and chunked, so multi-GB files are fine.
- A scheduled video is uploaded `private` and flips public at `publishAt`.
- `thumbnailPath` sets a custom thumbnail; the channel must be verified for it
  to stick.
- Quota is the real constraint: an upload costs ~1,600 units of a 10,000/day
  default quota, so roughly **6 uploads per day** before the API refuses.
- `#tags` in the description are what actually show above the title.

## TikTok

| | |
|---|---|
| Caption | 2,200 chars |
| Media | One video, or up to 35 photos |
| Source | Video: local path or public URL. Photos: **public URL only** |
| Publish | Always asynchronous — always poll `get_publish_status` |
| Comments | **Not exposed by the API at all** |
| Delete | Not supported |

- The app must pass TikTok's audit before it can post publicly. Until then
  every post is forced to `SELF_ONLY` (private) — the server warns when this
  happens, and that warning must reach the user.
- `creator_info` is queried before each post to discover which privacy levels
  are currently allowed.
- Video: MP4/MOV/WEBM, up to 60 min depending on the account, under 4GB.
- The refresh token **rotates on every use**. The server persists the new one;
  never hand-edit it out of the config.

## X (Twitter)

| | |
|---|---|
| Post text | 280 chars |
| Media | Up to 4 images, or exactly 1 video (never mixed) |
| Source | Local path required |
| Threads | Supported via `thread` |
| Delete | Supported |

- For anything longer than 280 chars use `thread` rather than letting the text
  truncate.
- Free tier: **17 posts per 24 hours**, and `non_public_metrics` /
  `organic_metrics` need a paid tier. The server degrades to public metrics and
  records a note.
- Reading replies uses recent search, which only covers the last 7 days and
  needs the right access level.
- Video: MP4 H.264 + AAC, up to 140s and 512MB on standard access.

## LinkedIn

| | |
|---|---|
| Commentary | 3,000 chars |
| Media | One image or one video |
| Source | Local path required |
| Delete | Supported |

- `authorUrn` decides everything: `urn:li:organization:123` (company page) or
  `urn:li:person:abc` (personal profile).
- **Analytics exist for company pages only.** A personal profile returns empty
  totals with an explanatory note — LinkedIn has no member analytics API.
- The API version is pinned by the `LinkedIn-Version` header, default `202506`;
  override with the `LINKEDIN_VERSION` env var when LinkedIn deprecates it.
- The new post's URN comes back in the `x-restli-id` response header, not the body.

## Scheduling support

| Platform | Native (server-side) | Via the queue |
|---|---|---|
| YouTube | **yes** — `scheduledAt` in content, uploads private and self-publishes | yes |
| Instagram | no | yes |
| TikTok | no | yes |
| X | no | yes |
| LinkedIn | no | yes |

Prefer YouTube's native scheduling: once the upload finishes, nothing of yours
needs to be running. Everything else depends on `social-mcp --worker` (or a
cron `--run-due`) being alive at the scheduled moment; otherwise the job is
marked `missed` rather than published late.

## Choosing what to post where

| Asset | Goes to |
|---|---|
| Vertical short video (9:16, <60s) | Instagram Reels, TikTok, YouTube Shorts |
| Long-form horizontal video | YouTube |
| Single image + caption | Instagram, X, LinkedIn |
| Image carousel | Instagram, TikTok (as photos) |
| Text only | X, LinkedIn (Instagram and TikTok will reject it) |
