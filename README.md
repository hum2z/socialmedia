# social-mcp

Run all your social accounts through Claude — two Instagram accounts, two
YouTube channels, two TikToks, two X accounts, a LinkedIn page, as many as you
configure. Post to all of them at once, schedule for later, and pull the
analytics back from each.

Everything goes through the platforms' **official APIs**: no scraping, no
browser automation, nothing that gets an account banned.

## Setup: paste one line into Claude

You don't have to read the rest of this. Give Claude the link and let it do the
work:

> **Set up github.com/hum2z/socialmedia for me**

Claude will clone the repo, build it, register the server with your Claude
client, then walk you through connecting your accounts **one platform at a
time** — telling you exactly which developer portal to open, which permissions
to tick, and where to paste the token it gives you. It checks each account
against the live API before moving to the next, so you find out immediately if
something is wrong instead of the first time you try to post.

Then you can just talk to it:

> Post this to both my Instagram accounts and TikTok.

If you already have credentials and want to add an account directly:

> Add my main Instagram — user id 17841400000000001, token's in `$IG_MAIN_TOKEN`.

Claude follows the [`social-setup` skill](.claude/skills/social-setup/SKILL.md)
in this repo, so it knows the whole procedure and won't ask you to paste secrets
into the chat.

**Worth knowing before you start:** each platform needs its own developer app,
and Instagram and TikTok both require app review before they'll post publicly.
Claude will tell you this as it goes, but it's the reason setup takes an
afternoon rather than five minutes. If you only want analytics and not posting,
the requirements are much lighter.

<details>
<summary><b>Prefer to set it up yourself?</b></summary>

Everything below is the manual path — install, credentials per platform,
scheduling and the tool reference. Nothing here is required if you let Claude
do it.

</details>

## What it does

- **Cross-post** one piece of content to any set of accounts, adapted per
  platform: 280 chars on X, a 100-char title on YouTube, hashtags where they
  belong.
- **Many accounts per platform**, addressed by id (`ig_main`, `ig_alt`), by
  platform (`instagram`), by tag (`tag:brand`), or `all`.
- **Analytics** for every account in one call, with a date range and a per-day
  series where the platform offers one.
- **Schedule posts** for a future time, with timezone handling, retries and
  bounded recurrence — see [Scheduling](#scheduling) for what has to be running.
- **Comments** — read them, reply to them.
- **Never posts by accident.** `publish`, `reply_to_comment` and `delete_post`
  all require `confirm: true`; without it you get a dry run.

## Platforms

| | Post | Analytics | Comments | Delete | Notes |
|---|---|---|---|---|---|
| Instagram | images, carousels, Reels | account + post | read, reply | ✗ | Business/Creator account; media by public URL |
| YouTube | video, scheduled or live | account + post | read, reply | ✓ | resumable chunked upload |
| TikTok | video, photo carousels | profile + post | ✗ | ✗ | async publish; app audit needed to post publicly |
| X | text, images, video, threads | profile + post | read, reply | ✓ | 17 posts/day on the free tier |
| LinkedIn | text, image, video | pages only | read, reply | ✓ | personal profiles have no analytics API |

Adding a platform means writing one adapter and registering it in
`src/platforms/index.ts`.

## Manual install

```bash
npm install
npm run build
```

Register it with Claude Code:

```bash
claude mcp add social -- node /absolute/path/to/socialmedia/dist/index.js
```

Or in `claude_desktop_config.json` / `.mcp.json`:

```json
{
  "mcpServers": {
    "social": {
      "command": "node",
      "args": ["/absolute/path/to/socialmedia/dist/index.js"]
    }
  }
}
```

Two skills ship with this repo and load automatically when it is your working
directory — copy them to `~/.claude/skills/` to use them anywhere:

- **`social-setup`** — installs and configures everything, and walks you through
  credentials one platform at a time.
- **`social-media`** — the day-to-day workflow: draft per platform, preview,
  confirm, publish, then follow the async posts until they land.

The same binary also runs standalone:

```bash
node dist/index.js --help       # all modes and environment variables
node dist/index.js --doctor     # verify credentials, show the scheduled queue
node dist/index.js --worker     # run the scheduler in the background
node dist/index.js --run-due    # fire due posts once, then exit (for cron)
```

## Connect your accounts

> Claude can do all of this for you — see [Setup](#setup-paste-one-line-into-claude).
> What follows is the same procedure written out, for doing it by hand or for
> checking Claude's work.

Every platform here uses its **official API**, so each one needs a developer app
and an authorized account. Budget an afternoon for the first setup — and note
that Instagram and TikTok both require app review before they will post
publicly. After that, adding a second account on a platform you have already set
up takes about two minutes: it is the same app, just another OAuth run.

### Where credentials live

The registry is `~/.config/social-mcp/accounts.json` (override with
`SOCIAL_MCP_CONFIG`). Start from [`accounts.example.json`](accounts.example.json).

Any credential can be written as `env:VAR_NAME` to read it from the environment
instead of storing the secret on disk — do that for anything long-lived:

```json
{
  "id": "ig_main",
  "platform": "instagram",
  "label": "Main brand Instagram",
  "handle": "@brand",
  "tags": ["brand"],
  "credentials": {
    "igUserId": "17841400000000001",
    "accessToken": "env:IG_MAIN_TOKEN"
  }
}
```

The `id` is how you target the account (`ig_main`), and `tags` let you address
groups (`tag:brand`). Two accounts on one platform are just two entries with
different ids — nothing else is special about them.

You do not have to edit the file by hand. Ask Claude:

> Add my main Instagram — IG user id 17841400000000001, token is in `$IG_MAIN_TOKEN`.

which calls `add_account` and writes the entry for you (`0600`, in a `0700`
directory).

For the secrets themselves, copy `.env.example` to `.env`. The server reads
`.env` from `~/.config/social-mcp/` and from its working directory (override
with `SOCIAL_MCP_ENV_FILE`), so you don't have to forward every variable through
your MCP client config. A real environment variable always wins over the file.

### What each platform needs

| Platform | Credential keys | Where it comes from |
|---|---|---|
| `instagram` | `igUserId`, `accessToken` | Meta app + long-lived Page token |
| `youtube` | `clientId`, `clientSecret`, `refreshToken` | Google Cloud OAuth client |
| `tiktok` | `clientKey`, `clientSecret`, `refreshToken` | TikTok developer app |
| `x` | `clientId`, `refreshToken` (+ `clientSecret` if confidential) | X developer portal, OAuth 2.0 |
| `linkedin` | `accessToken`, `authorUrn` | LinkedIn developer app |

TikTok and X will also accept a plain `accessToken` in place of a refresh
token, for setups that hand you a long-lived one. Prefer the refresh token
where you can — it is the only form the server can renew on its own.

### Instagram

The account must be **Business or Creator** (not personal) and linked to a
Facebook Page.

1. Create an app at [developers.facebook.com](https://developers.facebook.com) →
   **Business** type, and add the **Instagram Graph API** product.
2. Request these permissions: `instagram_basic`, `instagram_content_publish`,
   `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`,
   `pages_read_engagement`.
3. In Graph API Explorer, generate a User token with those scopes, then exchange
   it for a **60-day long-lived token**:

   ```
   GET https://graph.facebook.com/v23.0/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id=APP_ID&client_secret=APP_SECRET
     &fb_exchange_token=SHORT_LIVED_TOKEN
   ```

4. Find your `igUserId`:

   ```
   GET /me/accounts                                   → your Page id
   GET /{page-id}?fields=instagram_business_account    → the IG user id
   ```

5. **Submit for App Review** on `instagram_content_publish` to post publicly.

The 60-day token must be refreshed before it expires — `--doctor` will tell you
when it has lapsed. Each Instagram account needs its own token, but they can
share one Meta app.

### YouTube

1. In [Google Cloud Console](https://console.cloud.google.com), create a project
   and enable both **YouTube Data API v3** and **YouTube Analytics API**.
2. Configure the OAuth consent screen, then create an **OAuth 2.0 Client ID** of
   type *Desktop app*. That gives you `clientId` and `clientSecret`.
3. Authorize with these scopes, requesting offline access:
   `youtube.upload`, `youtube.readonly`, `youtube.force-ssl`,
   `yt-analytics.readonly`.
4. Exchange the resulting code for a **refresh token** — that is the durable
   credential. The server refreshes short-lived access tokens itself and caches
   them in the registry.

One refresh token per channel is what makes two YouTube accounts work; both can
use the same `clientId`/`clientSecret`. Watch the quota: 10,000 units/day and
an upload costs ~1,600, so roughly **six uploads a day**.

### TikTok

1. Register at [developers.tiktok.com](https://developers.tiktok.com) and create
   an app with **Login Kit** and the **Content Posting API**.
2. Scopes: `user.info.basic`, `user.info.stats`, `video.publish`, `video.list`.
3. Run the OAuth flow per account to get a `refreshToken`.
4. **Submit the app for audit.** Until it passes, every post is forced to
   `SELF_ONLY` (private) regardless of what you request — the server surfaces a
   warning when this happens, so you will not be left guessing.
5. If you post via `PULL_FROM_URL`, verify the hosting domain in the portal.

TikTok rotates the refresh token on every use. The server persists the
replacement automatically — don't hand-edit it back.

### X (Twitter)

1. In the [X developer portal](https://developer.x.com), create a project and
   app, and set User authentication to **OAuth 2.0** with **Read and write**.
2. Scopes: `tweet.read`, `tweet.write`, `users.read`, `offline.access`.
   `offline.access` is what produces the refresh token.
3. Run the PKCE authorization flow once per account for its `refreshToken`.
   Public clients need only `clientId`; confidential clients also send
   `clientSecret`.

The free tier allows **17 posts/24h** and hides `organic_metrics` and
`non_public_metrics` — the server falls back to public metrics and says so in
`notes` rather than reporting zeros.

### LinkedIn

1. Create an app at [linkedin.com/developers](https://www.linkedin.com/developers),
   associated with your company page.
2. Request the **Community Management API** (approval required) for pages, or
   **Share on LinkedIn** + **Sign In with OpenID Connect** for a personal profile.
3. Scopes: `w_member_social` for a profile, or `w_organization_social` +
   `r_organization_social` + `rw_organization_admin` for a page.
4. `authorUrn` decides what you post as:
   - company page → `urn:li:organization:<id>`
   - personal profile → `urn:li:person:<sub>`, where `sub` comes from `/v2/userinfo`

Access tokens last 60 days and member tokens have no refresh flow, so
re-authorize when they lapse. Analytics exist for **company pages only**.

### Verify before you rely on it

```bash
node dist/index.js --doctor
```

```
social-mcp doctor
config: /home/you/.config/social-mcp/accounts.json

• ig_main (instagram) … ok — @brand, 24310 followers, 47 posts left today
• yt_main (youtube)   … ok — @brandtv, 8120 followers
• tt_alt  (tiktok)    … FAILED
    tiktok: refresh token expired — re-authorize this account

2/3 account(s) healthy.
```

`check_account` does the same thing from inside a conversation. Run it at the
start of a posting session — finding an expired token before you draft is much
better than after.

### Keeping secrets safe

- Prefer `env:` indirection over literals in the file.
- `accounts.json` is gitignored and written `0600`, but it is still plaintext.
- Revoke tokens from the platform's own settings page — removing an entry here
  only stops this server from using it.

## Scheduling

Queue a post for later:

> Schedule this Reel for both Instagram accounts on Friday at 9am Berlin time.

which calls `schedule_post`. Validation runs **at scheduling time**, so a post
that could never succeed is refused immediately rather than failing silently at
9am on Friday.

### What has to be running

This is the part worth understanding before you rely on it. An MCP server over
stdio only exists while its client is connected — when you close Claude, the
process ends. So a queued post needs something alive at the moment it comes due.
There are three ways to get that, and you can mix them:

| | Fires when | Best for |
|---|---|---|
| **The MCP server** | while Claude is connected | posts a few minutes/hours out, during a session |
| **`--worker`** | always, once you start it | anything unattended — this is the real answer |
| **`--run-due` from cron** | whenever cron fires it | machines that already run cron |

Nothing is lost if none of them is running: a job whose time passes is marked
**`missed`**, not published hours late. A 9am announcement landing at 6pm is
usually worse than not landing, so the default catch-up window is 120 minutes
(`SOCIAL_MCP_CATCH_UP_MINUTES`). `list_scheduled` and `--doctor` both show
missed jobs, and `--doctor` warns when something is overdue with no worker up.

### Running the worker

```bash
node dist/index.js --worker --interval 60
```

**systemd** (Linux) — `~/.config/systemd/user/social-mcp.service`:

```ini
[Unit]
Description=social-mcp scheduler

[Service]
ExecStart=/usr/bin/node /path/to/socialmedia/dist/index.js --worker
Restart=always
Environment=SOCIAL_MCP_CONFIG=%h/.config/social-mcp/accounts.json

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now social-mcp
```

**launchd** (macOS) — `~/Library/LaunchAgents/social-mcp.plist` with
`RunAtLoad` and `KeepAlive` set, pointing at the same command.

**cron** — no daemon, just a periodic check:

```cron
*/5 * * * * /usr/bin/node /path/to/socialmedia/dist/index.js --run-due >> ~/.social-mcp.log 2>&1
```

Running the worker *and* having Claude connected is safe: the queue is guarded
by a lock file, so exactly one of them claims each job.

### Times and timezones

`scheduledFor` accepts three forms:

| Form | Example | Meaning |
|---|---|---|
| ISO with offset | `2026-09-01T15:00:00Z`, `…+02:00` | exact, unambiguous |
| wall clock + `timezone` | `2026-09-01 15:00` + `Europe/Berlin` | resolved through that zone, DST included |
| relative | `+2h`, `+30m`, `+3d` | from now |

A bare time with no zone is read as the **server's** local time and returns a
warning saying so — that is the mistake that posts at the wrong hour. Every
response echoes back how the time was interpreted, in UTC, so it can be checked
before it matters.

### Retries, recurrence and failure

- If **every** target fails, the job retries with backoff (5, 10, 20 minutes) up
  to `maxAttempts`.
- If **some** targets succeeded, the job is done — it never re-posts to an
  account that already published.
- `repeat` gives simple recurrence (`hour`/`day`/`week` × `interval`), and
  requires a `count`, so a schedule can never run away.
- A crashed worker leaves no job stuck: stale locks are reclaimed after 15
  minutes and the job runs on the next tick.

### Native scheduling

YouTube can schedule server-side: pass `scheduledAt` in the **content** and the
video uploads now as private and goes public by itself, with nothing of yours
running. That is strictly more reliable than the queue, so prefer it for
YouTube. No other platform here offers it.

## Using it

Talk to Claude normally:

> Post this Reel to both Instagram accounts and TikTok — topic "spring drop",
> caption from the brief, link in the first comment.

> How did last week go across all my accounts? Which posts beat their account
> average?

> Show me unanswered comments on my last three YouTube videos.

Under the hood that is `list_accounts` → `preview_post` → your go-ahead →
`publish` → `get_publish_status`.

### Tools

| Tool | Purpose |
|---|---|
| `list_accounts` | every configured account and what it can do |
| `check_account` | verify credentials, refresh tokens, report quota |
| `preview_post` | dry run: rendered output + validation, per target |
| `publish` | post to many accounts (needs `confirm: true`) |
| `get_publish_status` | poll TikTok / Instagram async publishes |
| `account_analytics` | metrics per account over a date range |
| `post_analytics` | full metrics for one post |
| `list_posts` | recent posts with headline metrics |
| `list_comments` | comments on a post |
| `reply_to_comment` | comment or reply (needs `confirm: true`) |
| `delete_post` | remove a post (needs `confirm: true`) |
| `schedule_post` | queue a post for later (needs `confirm: true`) |
| `list_scheduled` | the queue: pending, done, failed, missed |
| `cancel_scheduled` | drop a queued post (needs `confirm: true`) |
| `reschedule_post` | move a queued post to a new time |
| `run_due_posts` | force a check for due posts now |
| `add_account` / `remove_account` | manage the registry |
| `platform_capabilities` | limits and features per platform |

## Development

```bash
npm run typecheck       # tsc --noEmit
npm run build           # compile to dist/
npm test                # all three suites — 233 assertions, no credentials needed
npm run test:tools      # MCP tool layer only
npm run test:adapters   # platform adapters only
npm run test:scheduler  # queue, timezones, retries, locking
SOCIAL_MCP_DEBUG=1 …    # request logging on stderr
```

**`test/smoke.mjs`** starts the real server over a stdio transport against a
throwaway config and drives it as a client would: tool registration, target
resolution, per-platform validation, content overrides, and every confirmation
gate.

**`test/adapters.mjs`** runs the adapters against a stubbed `fetch` that speaks
each platform's actual protocol back at them — so it checks the things that are
easy to get wrong and expensive to discover live: Instagram's container flow and
carousel children, YouTube's resumable chunk ranges over a deliberately
non-aligned 25MB file, TikTok's chunk arithmetic and rotating refresh token,
X's INIT/APPEND/FINALIZE and thread chaining, LinkedIn's `x-restli-id` header,
plus retry/backoff, `Retry-After`, and the degraded paths where a platform
gates a metric.

**`test/scheduler.mjs`** covers the queue end to end with publishing stubbed at
the adapter boundary: timezone and DST conversion, the catch-up window, retry
backoff, partial-success handling, bounded recurrence, reclaiming jobs from a
crashed process, and two runners racing for the same job (exactly one wins). It
also spawns a real `--worker` process and checks it survives past its first
tick — a regression test for a bug where an unref'd timer made the worker exit
immediately.

That covers everything up to the network boundary. What it cannot prove is that
the live platform accepts the request — only real credentials do that, which is
what `--doctor` is for.

### Layout

```
src/
  index.ts           entry point: MCP server, --worker, --run-due, --doctor
  server.ts          MCP tool definitions
  config.ts          account registry, env: indirection, target resolution
  publish.ts         shared publish path used by the tool and the scheduler
  scheduler/
    store.ts         persistent queue, file locking, recurrence
    runner.ts        claims due jobs, retries, catch-up window
    time.ts          timezone-aware time parsing
  types.ts           shared domain types
  platforms/
    base.ts          the adapter interface + generic validation
    instagram.ts youtube.ts tiktok.ts x.ts linkedin.ts
  util/              http (retry/backoff), media, errors, logging
CLAUDE.md            repo context + conventions, auto-loaded by Claude Code
.claude/skills/
  social-setup/      guided install and credential onboarding
  social-media/
    SKILL.md         the posting and analytics workflow
    references/      platform limits, credential setup, metric definitions
test/
  smoke.mjs          MCP tool layer, over a real stdio transport
  adapters.mjs       platform adapters against a mocked API surface
  scheduler.mjs      queue, timezones, retries, locking, worker liveness
```

## Notes and limits

- **Rate limits are real.** Instagram: 50 posts/24h. YouTube: ~6 uploads/day on
  the default quota. X free tier: 17 posts/24h. The server surfaces these rather
  than retrying into a ban.
- **Instagram and TikTok both need app review** before they will post publicly.
  Until TikTok's audit passes, every TikTok post is forced private — the server
  warns when that happens.
- **TikTok exposes no comment API**, and **LinkedIn has no analytics for personal
  profiles**. Those return clear explanations, not empty results.
- **Scheduled posts need a running process.** Use `--worker`; without it, posts
  queued for when Claude is closed will be marked missed rather than published.
- Tokens expire: Instagram at 60 days, LinkedIn at 60 days, TikTok rotates on
  every refresh. `--doctor` is the fastest way to find out.
- `accounts.json` is written `0600` inside a `0700` directory, and is gitignored.
  It is still plaintext — prefer `env:` indirection for anything long-lived.

## License

[MIT](LICENSE) — use it, change it, ship it. Keep the copyright notice.
