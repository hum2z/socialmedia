# social-mcp

An MCP server that lets Claude post to **many social accounts at once** and pull
analytics back from each one — two Instagram accounts, two YouTube channels, two
TikToks, two X accounts, a LinkedIn page, as many as you configure.

It ships with a **Claude skill** (`.claude/skills/social-media/`) that teaches
Claude the workflow: draft per platform, preview, confirm with you, publish, then
follow the async ones until they land.

Everything goes through the platforms' **official APIs**. That means real
developer apps and real OAuth — see [setup](.claude/skills/social-media/references/setup.md)
— but it also means nothing here breaks the moment a platform changes its HTML,
and no account gets banned for automation.

## What it does

- **Cross-post** one piece of content to any set of accounts, adapted per
  platform: 280 chars on X, a 100-char title on YouTube, hashtags where they
  belong.
- **Many accounts per platform**, addressed by id (`ig_main`, `ig_alt`), by
  platform (`instagram`), by tag (`tag:brand`), or `all`.
- **Analytics** for every account in one call, with a date range and a per-day
  series where the platform offers one.
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

## Install

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

The skill in `.claude/skills/social-media/` loads automatically when this repo
is your working directory. To use it anywhere, copy that folder to
`~/.claude/skills/`.

## Configure your accounts

Credentials live in `~/.config/social-mcp/accounts.json` (override with
`SOCIAL_MCP_CONFIG`). Start from [`accounts.example.json`](accounts.example.json).

Any credential can be written as `env:VAR_NAME` to read it from the environment
instead of storing the secret on disk:

```json
{
  "id": "ig_main",
  "platform": "instagram",
  "tags": ["brand"],
  "credentials": {
    "igUserId": "17841400000000001",
    "accessToken": "env:IG_MAIN_TOKEN"
  }
}
```

Easier: just ask Claude — *"add my main Instagram, the token is in
`$IG_MAIN_TOKEN`"* — and it calls `add_account` for you. Then check everything:

```bash
node dist/index.js --doctor
```

```
• ig_main (instagram) … ok — @brand, 24310 followers, 47 posts left today
• yt_main (youtube)   … ok — @brandtv, 8120 followers
• tt_alt  (tiktok)    … FAILED
    tiktok: refresh token expired — re-authorize this account
```

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
| `add_account` / `remove_account` | manage the registry |
| `platform_capabilities` | limits and features per platform |

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run build         # compile to dist/
npm test              # end-to-end smoke test over stdio, no credentials needed
SOCIAL_MCP_DEBUG=1 …  # request logging on stderr
```

`npm test` starts the real server over a stdio transport against a throwaway
config and exercises every tool that doesn't need live credentials — target
resolution, per-platform validation, content overrides, and the confirmation
gates.

### Layout

```
src/
  index.ts           entry point + --doctor
  server.ts          MCP tool definitions
  config.ts          account registry, env: indirection, target resolution
  types.ts           shared domain types
  platforms/
    base.ts          the adapter interface + generic validation
    instagram.ts youtube.ts tiktok.ts x.ts linkedin.ts
  util/              http (retry/backoff), media, errors, logging
.claude/skills/social-media/
  SKILL.md           the workflow Claude follows
  references/        platform limits, credential setup, metric definitions
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
- Tokens expire: Instagram at 60 days, LinkedIn at 60 days, TikTok rotates on
  every refresh. `--doctor` is the fastest way to find out.
- `accounts.json` is written `0600` inside a `0700` directory, and is gitignored.
  It is still plaintext — prefer `env:` indirection for anything long-lived.
