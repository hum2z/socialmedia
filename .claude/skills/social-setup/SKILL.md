---
name: social-setup
description: Install and configure the social-mcp server for a new user — clone and build it, register it with their Claude client, walk them through obtaining API credentials for Instagram, YouTube, TikTok, X or LinkedIn one platform at a time, and verify everything works. Use when someone points you at the social-mcp repo and asks you to set it up, install it, connect their accounts, or get them started, or when they hit credential errors and need to re-authorize an account.
---

# Setting up social-mcp for someone

Your job is to get them from "here's a repo link" to "my accounts are
connected" without them having to read any documentation. Do the mechanical
work yourself; only ask them for things that genuinely require their hands —
logging into a developer portal, clicking Authorize, pasting a token into a file.

Work **one platform at a time**, and get it fully working before starting the
next. Someone who connects one account and sees it verify will finish the rest.
Someone handed a five-platform checklist will abandon it.

## Step 1 — Build it

```bash
git clone https://github.com/hum2z/socialmedia.git
cd socialmedia
npm install
npm run build
npm test        # ~236 assertions, no credentials needed — confirms it's sound
```

If `npm test` fails, stop and fix that before going further. Do not start
collecting credentials against a broken build.

## Step 2 — Register the server

For Claude Code:

```bash
claude mcp add social -- node "$(pwd)/dist/index.js"
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "social": { "command": "node", "args": ["/absolute/path/to/socialmedia/dist/index.js"] }
  }
}
```

Use the real absolute path — `$(pwd)` will not expand inside a JSON file. Tell
them to restart their client so the tools load.

## Step 3 — Ask what they actually want

Before touching any developer portal, ask two things:

1. **Which platforms?** Instagram, YouTube, TikTok, X, LinkedIn.
2. **How many accounts on each,** and what to call them (`ig_main`, `ig_alt`).

Then set expectations honestly, because these two will otherwise feel like
failures later:

- **Instagram** needs a Business or Creator account linked to a Facebook Page,
  and App Review before it can post publicly.
- **TikTok** forces every post private until their app passes audit.

If they only want analytics and not posting, say so — the review requirements
are much lighter, and that may be all they need today.

## Step 4 — Credentials, one platform at a time

`references/setup.md` in the `social-media` skill has the full per-platform
walkthrough. Read it for the platform you are on, then guide them through it
step by step, with the exact URLs and scope names. Do not paste the whole
document at them.

**Keep secrets out of the conversation.** Have them write the token into the
project's `.env` file themselves, then register the account referencing the
variable — never ask them to paste a token into chat, and never echo one back:

```
# they add this to .env
IG_MAIN_TOKEN=<their token>
```

Then you call:

```
add_account
  id: "ig_main"
  platform: "instagram"
  handle: "@theirhandle"
  tags: ["brand"]
  credentials: { igUserId: "1784…", accessToken: "env:IG_MAIN_TOKEN" }
```

The `igUserId` is not a secret, so it is fine inline. The token is, so it stays
behind `env:`.

Immediately run `check_account` for the account you just added. Fix it now while
they still have the portal open — a 401 an hour later is much harder to debug.

## Step 5 — Prove it works

Run `check_account` across everything, then show them:

- their handle and follower count read back from the live API
- for Instagram, the remaining posts in the 24-hour publish quota

Then do a **dry run**, not a real post:

```
preview_post targets=["all"] content={ topic: "…", description: "…" }
```

This shows exactly what each account would receive, and surfaces any validation
problem, without publishing anything. Let them see that before they trust it
with a real post.

## Step 6 — Offer the scheduler, but only if they need it

If they want to schedule posts, explain the one thing that will otherwise bite
them: scheduled posts only fire while something is running. Set up the worker:

```bash
node dist/index.js --worker      # or systemd/launchd — see the README
```

If they only ever post in the moment, skip this entirely.

## When something fails

- **401/403** — the token is wrong, expired, or missing a scope. Check the
  scopes first; it is usually a missing scope, not a bad token.
- **Instagram "container ERROR"** — the media itself broke the codec, duration
  or aspect-ratio rules. Not a credentials problem.
- **`npm test` fails** — a real bug or a broken environment. Investigate; do
  not work around it.
- **Tool not found** — the client did not reload. Have them restart it.

Tell them plainly what is wrong and what to do. Never imply an account is
connected when `check_account` has not confirmed it.
