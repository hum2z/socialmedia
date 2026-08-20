/**
 * End-to-end smoke test: starts the server over stdio exactly as a client
 * would, then exercises every tool that does not require live credentials.
 * Uses a throwaway config file so a real registry is never touched.
 *
 *   npm run build && node test/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workdir = await mkdtemp(path.join(tmpdir(), "social-mcp-smoke-"));
const configFile = path.join(workdir, "accounts.json");

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, SOCIAL_MCP_CONFIG: configFile },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content?.[0]?.text ?? "", isError: Boolean(res.isError) };
};
const json = (text) => JSON.parse(text.slice(text.indexOf("{")));

try {
  console.log("\ntools");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`  registered: ${names.join(", ")}`);
  for (const expected of [
    "list_accounts", "check_account", "preview_post", "publish",
    "get_publish_status", "account_analytics", "post_analytics", "list_posts",
    "list_comments", "reply_to_comment", "delete_post", "add_account",
    "remove_account", "platform_capabilities", "schedule_post", "list_scheduled",
    "cancel_scheduled", "reschedule_post", "run_due_posts",
  ]) {
    check(`${expected} is registered`, names.includes(expected));
  }

  console.log("\nempty registry");
  const empty = await call("list_accounts");
  check("starts with zero accounts", json(empty.text).accountCount === 0);

  console.log("\nadding two accounts per platform");
  const fixtures = [
    ["ig_main", "instagram", { igUserId: "17841400000000001", accessToken: "env:IG_MAIN_TOKEN" }, ["brand"]],
    ["ig_alt", "instagram", { igUserId: "17841400000000002", accessToken: "env:IG_ALT_TOKEN" }, ["personal"]],
    ["yt_main", "youtube", { clientId: "c", clientSecret: "s", refreshToken: "env:YT_MAIN_REFRESH" }, ["brand"]],
    ["yt_alt", "youtube", { clientId: "c", clientSecret: "s", refreshToken: "env:YT_ALT_REFRESH" }, ["personal"]],
    ["tt_main", "tiktok", { clientKey: "k", clientSecret: "s", refreshToken: "env:TT_MAIN_REFRESH" }, ["brand"]],
    ["tt_alt", "tiktok", { clientKey: "k", clientSecret: "s", refreshToken: "env:TT_ALT_REFRESH" }, ["personal"]],
    ["x_main", "x", { clientId: "c", refreshToken: "env:X_MAIN_REFRESH" }, ["brand"]],
    ["x_alt", "x", { clientId: "c", refreshToken: "env:X_ALT_REFRESH" }, ["personal"]],
    ["li_page", "linkedin", { accessToken: "env:LI_TOKEN", authorUrn: "urn:li:organization:123" }, ["brand"]],
  ];
  for (const [id, platform, credentials, tags] of fixtures) {
    const res = await call("add_account", { id, platform, credentials, tags });
    check(`added ${id}`, !res.isError, res.text.slice(0, 120));
  }

  const listed = json((await call("list_accounts")).text);
  check("all nine accounts registered", listed.accountCount === 9, `got ${listed.accountCount}`);
  const igOnly = json((await call("list_accounts", { platform: "instagram" })).text);
  check("platform filter returns both IG accounts", igOnly.accountCount === 2);

  console.log("\ntarget selectors");
  const brandPreview = json((await call("preview_post", {
    targets: ["tag:brand"],
    content: { topic: "Hi", description: "Body", media: [{ kind: "video", url: "https://e.com/v.mp4", path: "/tmp/v.mp4" }] },
  })).text);
  check("tag:brand resolves to 5 accounts", brandPreview.targets === 5, `got ${brandPreview.targets}`);

  const platformPreview = json((await call("preview_post", {
    targets: ["instagram"],
    content: { description: "Body", media: [{ kind: "image", url: "https://e.com/i.jpg" }] },
  })).text);
  check("platform selector resolves to 2 accounts", platformPreview.targets === 2);

  const unknown = await call("list_posts", { targets: ["does_not_exist"] });
  check("unknown target reports a clear error", unknown.isError && unknown.text.includes("does_not_exist"));

  console.log("\nvalidation");
  const overLimit = json((await call("preview_post", {
    targets: ["x_main"],
    content: { description: "A".repeat(400) },
  })).text);
  check("X flags a 400-char body as a truncation warning",
    overLimit.plan[0].warnings.some((w) => w.field === "description"));

  const noMedia = json((await call("preview_post", {
    targets: ["ig_main"],
    content: { description: "text only" },
  })).text);
  check("Instagram rejects a text-only post",
    noMedia.plan[0].errors.some((e) => e.field === "media"));

  const localOnly = json((await call("preview_post", {
    targets: ["ig_main"],
    content: { description: "hi", media: [{ kind: "image", path: "/tmp/local.jpg" }] },
  })).text);
  check("Instagram rejects a local-only path (needs a public URL)",
    localOnly.plan[0].errors.some((e) => e.message.includes("URL")));

  const longTitle = json((await call("preview_post", {
    targets: ["yt_main"],
    content: { topic: "T".repeat(120), media: [{ kind: "video", path: "/tmp/v.mp4" }] },
  })).text);
  check("YouTube rejects a 120-char title",
    longTitle.plan[0].errors.some((e) => e.field === "topic"));

  const mixedMedia = json((await call("preview_post", {
    targets: ["tt_main"],
    content: { description: "hi", media: [
      { kind: "video", path: "/tmp/v.mp4" }, { kind: "image", url: "https://e.com/i.jpg" }] },
  })).text);
  check("TikTok rejects mixing video and photos",
    mixedMedia.plan[0].errors.length > 0);

  console.log("\noverrides");
  const overridden = json((await call("preview_post", {
    targets: ["x_main", "yt_main"],
    content: { topic: "Shared topic", description: "Shared body", media: [{ kind: "video", path: "/tmp/v.mp4" }] },
    overrides: { x_main: { description: "Punchy X version" }, youtube: { topic: "YT-specific title" } },
  })).text);
  const xPlan = overridden.plan.find((p) => p.accountId === "x_main");
  const ytPlan = overridden.plan.find((p) => p.accountId === "yt_main");
  check("per-account override applied to x_main", xPlan.wouldPost.text === "Punchy X version");
  check("per-platform override applied to youtube", ytPlan.wouldPost.title === "YT-specific title");

  console.log("\nconfirmation gates");
  const unconfirmed = json((await call("publish", {
    targets: ["tag:brand"],
    content: { topic: "Nope", description: "Should not post", media: [{ kind: "video", path: "/tmp/v.mp4" }] },
  })).text);
  check("publish without confirm does not post", unconfirmed.published === false);
  check("publish without confirm still returns a plan", Array.isArray(unconfirmed.plan) && unconfirmed.plan.length === 5);

  const unconfirmedComment = json((await call("reply_to_comment", {
    accountId: "ig_main", postId: "123", text: "hi",
  })).text);
  check("reply_to_comment without confirm does not post", unconfirmedComment.posted === false);

  const unconfirmedDelete = json((await call("delete_post", {
    accountId: "yt_main", postId: "abc",
  })).text);
  check("delete_post without confirm does not delete", unconfirmedDelete.deleted === false);

  const igDelete = await call("delete_post", { accountId: "ig_main", postId: "abc", confirm: true });
  check("Instagram delete is refused with an explanation",
    igDelete.isError && igDelete.text.includes("does not allow"));

  console.log("\ncapabilities");
  const caps = json((await call("platform_capabilities")).text);
  check("capabilities cover all five platforms", caps.platforms.length === 5);
  check("X caption limit is 280", caps.platforms.find((p) => p.platform === "x").captionLimit === 280);

  console.log("\nregistry mutation");
  const removed = json((await call("remove_account", { id: "li_page", confirm: true })).text);
  check("account removed", removed.removed === true && removed.remaining === 8);

  console.log("\nscheduling");
  const schedDry = json((await call("schedule_post", {
    targets: ["x_main"], content: { description: "later" }, scheduledFor: "+2h",
  })).text);
  check("schedule_post without confirm does not queue", schedDry.scheduled === false);
  check("dry run still resolves the time", Boolean(schedDry.wouldRunAt));

  const scheduled = json((await call("schedule_post", {
    targets: ["x_main", "x_alt"], content: { topic: "Launch", description: "body" },
    scheduledFor: "2026-12-01 09:00", timezone: "Europe/Berlin", confirm: true,
  })).text);
  check("schedule_post with confirm queues the job", scheduled.scheduled === true);
  check("the job gets an id", scheduled.id?.startsWith("sched_"));
  check("the zone is applied (09:00 Berlin = 08:00Z in winter)",
    scheduled.runsAt === "2026-12-01T08:00:00.000Z", scheduled.runsAt);
  check("the user is told it needs something running",
    scheduled.warnings.some((w) => w.includes("worker")));

  const pastSchedule = await call("schedule_post", {
    targets: ["x_main"], content: { description: "x" },
    scheduledFor: "2020-01-01T00:00:00Z", confirm: true,
  });
  check("a past time is refused", pastSchedule.isError && pastSchedule.text.includes("past"));

  const invalidSchedule = await call("schedule_post", {
    targets: ["ig_main"], content: { description: "no media" },
    scheduledFor: "+3h", confirm: true,
  });
  check("a job that would fail validation is refused up front",
    invalidSchedule.isError && invalidSchedule.text.includes("fail validation"));

  const listed2 = json((await call("list_scheduled", {})).text);
  check("the queued job is listed", listed2.jobs.some((j) => j.id === scheduled.id));
  check("listings show a relative time",
    listed2.jobs.find((j) => j.id === scheduled.id).relative.length > 0);

  const moved = json((await call("reschedule_post", {
    id: scheduled.id, scheduledFor: "2026-12-02T10:00:00Z",
  })).text);
  check("reschedule moves the job", moved.runsAt === "2026-12-02T10:00:00.000Z");

  const cancelDry = json((await call("cancel_scheduled", { id: scheduled.id })).text);
  check("cancel without confirm does nothing", cancelDry.cancelled === false);
  const cancelled = json((await call("cancel_scheduled", {
    id: scheduled.id, confirm: true })).text);
  check("cancel with confirm works", cancelled.cancelled === true);
  const afterCancel = json((await call("list_scheduled", { status: "cancelled" })).text);
  check("the job shows as cancelled",
    afterCancel.jobs.some((j) => j.id === scheduled.id));
  const recancel = await call("cancel_scheduled", { id: scheduled.id, confirm: true });
  check("cancelling twice is refused clearly",
    recancel.isError && recancel.text.includes("already finished"));
  const ghost = await call("cancel_scheduled", { id: "sched_nope", confirm: true });
  check("cancelling an unknown id is refused", ghost.isError);

  const due = json((await call("run_due_posts", {})).text);
  check("run_due_posts without confirm does not publish", due.executed === false);

  console.log("\ncredential resolution");
  const check1 = json((await call("check_account", { targets: ["ig_main"] })).text);
  check("missing env credential is reported, not crashed",
    check1.results[0].ok === false && /IG_MAIN_TOKEN/.test(check1.results[0].error),
    check1.results[0].error);
} finally {
  await client.close();
  await rm(workdir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
