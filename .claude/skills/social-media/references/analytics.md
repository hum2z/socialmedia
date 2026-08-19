# Reading the analytics

## What each platform actually gives you

| Metric | Instagram | YouTube | TikTok | X | LinkedIn |
|---|---|---|---|---|---|
| Day-level account series | yes | yes | **no** | **no** | pages only |
| Reach / unique viewers | yes | no | no | no | yes (impressions) |
| Views | yes | yes | yes | impressions | yes |
| Watch time | no | yes | no | no | no |
| Follower count | yes | yes | yes | yes | pages only |
| Follower delta over range | no | yes | no | no | no |
| Per-post engagement | yes | yes | yes | yes | yes |
| Comments readable | yes | yes | **no** | 7 days only | yes |

Where a platform has no day-level report, the server sums the posts that fall
inside the requested window and says so in `notes`. That is a different number
from a true account report — it excludes anything published before the window
that kept earning views inside it. Say which one you are quoting.

## Metrics that look alike but are not

- **Instagram reach** = unique accounts. **Views** = total plays. Reach is
  always the smaller and more honest number.
- **YouTube views** need ~30 seconds of watch time. **TikTok views** count from
  the first frame. A TikTok view is worth far less than a YouTube view, so
  never put them in the same ranking.
- **X impressions** count timeline appearances, including scrolled-past ones.
- **LinkedIn impressions** likewise; its `engagement` field is already a rate,
  not a count, so it must not be summed.
- **YouTube `averageViewDuration`** is a rate — the server averages it across
  days rather than summing.

## How to report

Lead with the rate, not the raw total:

- **Engagement rate** = (likes + comments + shares + saves) / reach, or /
  followers when reach is unavailable. Say which denominator you used.
- **View-through** = views / impressions.
- **Follower growth** = net change across the range. Only YouTube reports the
  gained/lost split directly.

Then rank *within* each platform, note the outliers, and look for what the top
posts share — format, length, posting time, topic. That comparison is the part
the user cannot get from the native dashboards, because those only ever show
one account at a time.

## A useful default workflow

```
account_analytics targets=["all"] since=… until=…    → the overview
list_posts targets=["all"] limit=10                  → what ran recently
post_analytics accountId=… postId=…                  → dig into the outliers
```

Two accounts on the same platform are the comparison worth making: same API,
same metric definitions, different audience. Differences there are real signal.
Cross-platform differences are mostly measurement artifacts.

## Caveats to state out loud

- Insights lag. Instagram and TikTok settle over roughly 48 hours; a post from
  this morning is not yet comparable to one from last week.
- Instagram insights do not cover posts made before the account became a
  Business account, and some older media types return nothing.
- X hides `non_public_metrics` below a paid tier; the server falls back to
  public metrics and records a note.
- A range that includes today is always partial.
- Never fill a gap with an estimate. An explicit "TikTok does not expose this"
  is more useful than a plausible number.
