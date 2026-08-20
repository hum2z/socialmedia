---
name: social-media
description: Publish to and analyze multiple social media accounts (Instagram, YouTube, TikTok, X, LinkedIn) through the social-mcp server. Use when the user wants to post, schedule, or cross-post content to their accounts; queue posts for a future time or manage a posting schedule; compare performance across accounts or platforms; check followers, views or engagement; or read and reply to comments. Triggers on "post this to", "publish to my accounts", "cross-post", "schedule this for", "post it tomorrow at", "what's queued", "how did my post do", "check my analytics", "compare my accounts", "reply to comments".
---

# Managing multiple social accounts

This skill drives the `social-mcp` server, which holds many accounts per
platform (two Instagram, two YouTube, two TikTok, and so on) and reaches each
one through its official API.

## Before anything else

Run `list_accounts` to learn which account ids exist. Never guess an id — the
user's naming is theirs, and posting to the wrong account is not undoable.

Run `check_account` at the start of a posting session. Tokens expire, and it is
far better to find that out before drafting than after.

## Publishing

The rule that matters: **never publish without the user's explicit go-ahead on
the final text.** `publish` requires `confirm: true`, and that flag represents
the user's decision, not your own confidence. The sequence is always:

1. **Draft per platform.** One blob of text posted five places reads as spam
   everywhere. Write for each platform (see `references/platforms.md`), passing
   the differences through `overrides`, keyed by account id or platform name.
2. **`preview_post`.** This renders exactly what each account would receive and
   surfaces validation errors — a 300-character X post, an Instagram post with
   no media, a 120-character YouTube title. Fix every error before continuing.
3. **Show the user.** Present the per-platform drafts and say plainly which
   accounts you are about to post to. Wait for their answer.
4. **`publish` with `confirm: true`.** Targets are attempted independently, so
   one platform failing does not block the others.
5. **Follow up on async platforms.** TikTok always returns `status: processing`
   with a `jobRef`; Instagram video sometimes does. Poll `get_publish_status`
   until it lands rather than telling the user it posted.
6. **Report honestly.** Say what published, what is still processing, and what
   failed with the reason. Never round a partial success up to "posted
   everywhere".

### Targeting

`targets` accepts account ids (`["ig_main", "yt_alt"]`), a whole platform
(`["instagram"]`), a tag (`["tag:brand"]`), or `["all"]`. Prefer the narrowest
selector that matches the request. When a user says "post everywhere", confirm
which accounts that means before using `all`.

### Writing the content

- `topic` — the headline. Becomes the YouTube title; leads the caption elsewhere.
- `description` — the body: caption, description, or post text.
- `hashtags` — without `#`. They are appended per platform convention.
- `media` — `url` for Instagram and TikTok photos, `path` for YouTube, X and
  LinkedIn uploads. Supply both when a file is available at each.
- `firstComment` — the "link in first comment" pattern.
- `thread` — extra posts chained under the first (X only).

## Scheduling

`schedule_post` queues a post for later. It also requires `confirm: true`,
because it commits to publishing while nobody is watching.

**Always tell the user what has to be running.** An MCP server over stdio only
lives while Claude is connected, so a post scheduled for tomorrow morning will
not fire on its own unless `social-mcp --worker` is running in the background.
The tool returns this warning on every scheduled job — pass it on the first time
someone schedules anything, rather than letting them discover it from a
`missed` job later. If they ask why a post did not go out, check
`list_scheduled` for `missed` before assuming a credentials problem.

**Be exact about time.** `scheduledFor` takes an ISO timestamp with an offset,
a wall-clock time paired with an IANA `timezone`, or a relative offset like
`+2h`. A bare time with no zone is read as the *server's* local zone, which is
often not the user's — if they say "9am Friday", ask which zone, or supply one
you already know. Every response echoes back how the time was interpreted in
UTC; show that back to the user so a mistake is caught before it matters.

**Prefer native scheduling for YouTube.** Passing `scheduledAt` inside the
*content* uploads the video now as private and lets YouTube publish it on
schedule, with nothing of the user's needing to run. That is strictly more
reliable than the queue. No other platform here can do it.

Use `list_scheduled` to show what is queued, `reschedule_post` to move
something, and `cancel_scheduled` to drop it. A recurring `repeat` needs a
`count` — recurrence is deliberately bounded, so if a user wants "every day
forever", agree a number with them.

## Analytics

`account_analytics` covers followers, reach and engagement over a date range
(28 days by default) and accepts many accounts at once — one call is enough to
compare every account the user owns.

`list_posts` finds post ids and shows headline metrics. `post_analytics` gives
the full picture for one post.

When reporting numbers:

- **Compare like with like.** A TikTok view and a YouTube view are not the same
  event. Rank within a platform, not across platforms.
- **Read the `notes` field and pass it on.** Platforms differ sharply in what
  they expose — TikTok has no day-level account report, LinkedIn has no
  analytics at all for personal profiles, X hides most metrics below a paid
  tier. The notes explain gaps; presenting a partial number as complete is
  worse than saying what is missing.
- **Give rates, not just totals.** Engagement per follower and per view is what
  tells the user whether something worked.
- **Say when a number is missing rather than inferring it.**

## Comments

`list_comments` reads them; `reply_to_comment` answers, and also requires
`confirm: true` because a reply is instantly public under the user's name.
Draft replies for the user to approve — never improvise in their voice at scale.
TikTok's API exposes no comments at all; say so rather than reporting zero.

## When something fails

The server returns the platform's own message plus what to do about it. The
usual causes:

- **401/403** — the token expired or lacks a scope. Run `check_account`, then
  point the user at `references/setup.md` for the re-authorization steps.
- **Instagram container ERROR** — the media failed Instagram's codec, duration
  or aspect-ratio rules, not a credentials problem.
- **TikTok privacy downgrade** — an unaudited app can only post `SELF_ONLY`.
  The warning says so; relay it, because the user's post will be private.
- **Rate limits** — Instagram allows 50 posts/24h (`check_account` reports what
  is left) and X's free tier allows 17/24h. Wait rather than retrying in a loop.
- **A scheduled post shows `missed`** — nothing was running when it came due.
  That is not a credentials failure; the fix is the worker, and the post needs
  re-scheduling or posting now.
- **A scheduled job is retrying** — every target failed and it will try again
  with backoff. If some targets succeeded it is already done, and the accounts
  that published will not be posted to twice.

## References

- `references/platforms.md` — per-platform limits, formats and quirks
- `references/setup.md` — how to obtain credentials for each platform
- `references/analytics.md` — what each metric means and how to compare them
