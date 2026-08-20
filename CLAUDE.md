# social-mcp

An MCP server that posts to and pulls analytics from many social accounts —
several per platform — across Instagram, YouTube, TikTok, X and LinkedIn,
through each platform's official API.

## Setting this up for a user

**If someone asks you to set this up, install it, or connect their accounts,
use the `social-setup` skill** (`.claude/skills/social-setup/`). It covers
building, registering the server with their client, obtaining credentials one
platform at a time, and verifying each account before moving on.

Two things to get right, because they are the ones that go wrong quietly:

- Never ask a user to paste a token into the conversation. Have them put it in
  `.env` and register the account with `env:VAR_NAME` indirection.
- Never tell a user an account is connected until `check_account` confirms it
  against the live API.

## Working on the code

```bash
npm run build           # compile to dist/ — required before any test run
npm test                # all three suites, ~236 assertions, no credentials
npm run typecheck
node dist/index.js --doctor    # verify real credentials, show the queue
SOCIAL_MCP_DEBUG=1 …           # log requests to stderr
```

Tests import from `dist/`, so **build before testing** or you will test stale
code.

## Layout

| Path | What lives there |
|---|---|
| `src/server.ts` | MCP tool definitions |
| `src/publish.ts` | shared publish path — used by the tool *and* the scheduler |
| `src/config.ts` | account registry, `env:` indirection, target resolution |
| `src/platforms/` | one adapter per platform, all behind `base.ts` |
| `src/scheduler/` | persistent queue, runner, timezone parsing |
| `src/util/http.ts` | every outbound call: retries, backoff, error translation |
| `test/` | tool layer, adapter protocols, scheduler |

## Conventions that matter

- **Adding a platform** means writing one adapter implementing `PlatformAdapter`
  and registering it in `src/platforms/index.ts`. Nothing else should need to change.
- **Anything that publishes, deletes or comments requires `confirm: true`**, and
  returns a dry run without it. Keep that gate on any new tool with public effects.
- **Never invent a metric.** When a platform does not expose something, say so in
  `notes` rather than returning a zero — several adapters depend on this and the
  tests assert it.
- **Fan-out is independent.** One platform failing must never abort the others.
- Secrets are written `0600`; never log a token, and never commit `accounts.json`.
