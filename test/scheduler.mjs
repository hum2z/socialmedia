/**
 * Scheduler tests: queue persistence, timezone resolution, the catch-up
 * window, retry backoff, recurrence, crash recovery, and the locking that
 * stops two processes double-posting.
 *
 * Publishing is intercepted at the adapter boundary, so jobs really do run
 * through the queue — nothing reaches a network.
 *
 *   npm run build && node test/scheduler.mjs
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workdir = await mkdtemp(path.join(tmpdir(), "social-mcp-sched-"));
process.env.SOCIAL_MCP_CONFIG = path.join(workdir, "accounts.json");
process.env.SOCIAL_MCP_QUEUE = path.join(workdir, "scheduled.json");

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

await writeFile(process.env.SOCIAL_MCP_CONFIG, JSON.stringify({
  version: 1,
  accounts: [
    { id: "x_main", platform: "x", tags: ["brand"], credentials: { clientId: "c", accessToken: "t" } },
    { id: "x_alt", platform: "x", tags: ["brand"], credentials: { clientId: "c", accessToken: "t" } },
  ],
}));

const store = await import("../dist/scheduler/store.js");
const { runDueJobs } = await import("../dist/scheduler/runner.js");
const { resolveWhen, relativeToNow } = await import("../dist/scheduler/time.js");
const { ADAPTERS } = await import("../dist/platforms/index.js");

// Intercept publishing at the adapter, so the queue machinery runs for real.
let published = [];
let publishBehavior = () => ({ status: "published", postId: "p1", url: "https://x.com/p1" });
ADAPTERS.x.publish = async (ctx, account, content) => {
  published.push({ accountId: account.id, topic: content.topic });
  const outcome = publishBehavior(account);
  if (outcome instanceof Error) throw outcome;
  return { accountId: account.id, platform: "x", ...outcome };
};

const ctx = { saveSession: async () => {} };
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const addJob = async (over = {}) => {
  const job = store.newJob({
    scheduledFor: iso(-1000), targets: ["x_main"],
    content: { description: "hello" }, ...over,
  });
  await store.withQueueLock(async (q) => { q.jobs.push(job); await store.saveQueue(q); });
  return job;
};
const getJob = async (id) =>
  (await store.withQueueLock((q) => q)).jobs.find((j) => j.id === id);
const resetQueue = async () => {
  published = [];
  await store.withQueueLock(async (q) => { q.jobs = []; await store.saveQueue(q); });
};

try {
  section("time · unambiguous input");
  {
    const utc = resolveWhen("2026-09-01T15:00:00Z");
    check("ISO with Z resolves exactly", utc.iso === "2026-09-01T15:00:00.000Z");
    check("no warning for an explicit instant", utc.warnings.length === 0);

    const offset = resolveWhen("2026-09-01T15:00:00+02:00");
    check("a +02:00 offset converts to UTC", offset.iso === "2026-09-01T13:00:00.000Z");

    const rel = resolveWhen("+2h");
    const delta = Date.parse(rel.iso) - Date.now();
    check("relative +2h lands two hours out",
      Math.abs(delta - 7_200_000) < 5_000, `${delta}ms`);
    check("relative +30m works", (() => {
      const d = Date.parse(resolveWhen("+30m").iso) - Date.now();
      return Math.abs(d - 1_800_000) < 5_000;
    })());
  }

  section("time · named zones and DST");
  {
    // Berlin is UTC+2 in summer (CEST) and UTC+1 in winter (CET).
    const summer = resolveWhen("2026-07-01 15:00", "Europe/Berlin");
    check("summer wall-clock converts at UTC+2",
      summer.iso === "2026-07-01T13:00:00.000Z", summer.iso);
    const winter = resolveWhen("2026-01-15 15:00", "Europe/Berlin");
    check("winter wall-clock converts at UTC+1 (DST handled)",
      winter.iso === "2026-01-15T14:00:00.000Z", winter.iso);
    const ny = resolveWhen("2026-07-04 09:30", "America/New_York");
    check("New York summer converts at UTC-4",
      ny.iso === "2026-07-04T13:30:00.000Z", ny.iso);
    check("a zone name is echoed in the interpretation",
      summer.interpretation.includes("Europe/Berlin"));
  }

  section("time · ambiguity is flagged, not guessed");
  {
    const bare = resolveWhen("2026-09-01 15:00");
    check("a bare time still resolves", Boolean(bare.iso));
    check("but it warns that no zone was given",
      bare.warnings.some((w) => w.includes("no timezone")), JSON.stringify(bare.warnings));
    const both = resolveWhen("2026-09-01T15:00:00Z", "Europe/Berlin");
    check("an explicit offset beats a redundant timezone arg",
      both.iso === "2026-09-01T15:00:00.000Z");
    check("and says the timezone was ignored",
      both.warnings.some((w) => w.includes("ignored")));

    for (const bad of ["not a time", "2026-13-45T99:00:00Z", ""]) {
      let threw = false;
      try { resolveWhen(bad); } catch { threw = true; }
      check(`rejects ${JSON.stringify(bad)}`, threw);
    }
    let badZone = false;
    try { resolveWhen("2026-09-01 15:00", "Mars/Olympus"); } catch { badZone = true; }
    check("rejects an unknown timezone", badZone);
    check("relativeToNow reads naturally",
      relativeToNow(iso(7_200_000)) === "in 2 hours", relativeToNow(iso(7_200_000)));
  }

  section("queue · persistence and isolation");
  {
    await resetQueue();
    const job = await addJob({ scheduledFor: iso(60_000), note: "later" });
    const onDisk = JSON.parse(await readFile(process.env.SOCIAL_MCP_QUEUE, "utf8"));
    check("the job is written to disk", onDisk.jobs.length === 1);
    check("it round-trips its id", onDisk.jobs[0].id === job.id);
    check("ids are namespaced", job.id.startsWith("sched_"));
    check("it starts pending", job.status === "pending");
    const tick = await runDueJobs(ctx);
    check("a future job is not fired", tick.ran.length === 0 && published.length === 0);
  }

  section("running · a due job publishes exactly once");
  {
    await resetQueue();
    const job = await addJob({ targets: ["tag:brand"], content: { topic: "T", description: "d" } });
    const tick = await runDueJobs(ctx);
    check("the due job ran", tick.ran.includes(job.id));
    check("it fanned out to both tagged accounts", published.length === 2,
      JSON.stringify(published.map((p) => p.accountId)));
    const after = await getJob(job.id);
    check("it is marked done", after.status === "done");
    check("results are recorded", after.results.length === 2);
    check("a finish time is stamped", Boolean(after.finishedAt));
    check("the lock is released", after.lock === undefined);

    const again = await runDueJobs(ctx);
    check("a second tick does not re-publish", again.ran.length === 0);
    check("still only two publishes total", published.length === 2);
  }

  section("running · the catch-up window stops very late posts");
  {
    await resetQueue();
    const fresh = await addJob({ scheduledFor: iso(-5 * 60_000) });   // 5 min late
    const stale = await addJob({ scheduledFor: iso(-5 * 3_600_000) }); // 5 hours late
    const tick = await runDueJobs(ctx);
    check("a slightly late post still goes out", tick.ran.includes(fresh.id));
    check("a very late post is marked missed", tick.missed.includes(stale.id));
    check("the missed post was NOT published", published.length === 1);
    const missed = await getJob(stale.id);
    check("missed is terminal", missed.status === "missed");
    check("the reason explains the window",
      missed.lastError.includes("catch-up window"), missed.lastError);
  }

  section("running · failures retry with backoff, then give up");
  {
    await resetQueue();
    publishBehavior = () => new Error("platform said no");
    const job = await addJob({ maxAttempts: 2 });

    let tick = await runDueJobs(ctx);
    check("a total failure is queued for retry", tick.retrying.includes(job.id));
    let after = await getJob(job.id);
    check("it returns to pending", after.status === "pending");
    check("a backoff time is set", Boolean(after.nextAttemptAt));
    check("the backoff is in the future", Date.parse(after.nextAttemptAt) > Date.now());
    check("the error is recorded", after.lastError.includes("platform said no"));

    tick = await runDueJobs(ctx);
    check("it is not retried before the backoff elapses", tick.ran.length === 0 &&
      tick.retrying.length === 0);

    // Jump past the backoff.
    await store.withQueueLock(async (q) => {
      q.jobs.find((j) => j.id === job.id).nextAttemptAt = iso(-1000);
      await store.saveQueue(q);
    });
    tick = await runDueJobs(ctx);
    check("the final attempt marks it failed", tick.failed.includes(job.id));
    after = await getJob(job.id);
    check("failed is terminal", after.status === "failed");
    check("attempts stopped at maxAttempts", after.attempts === 2, String(after.attempts));
    publishBehavior = () => ({ status: "published", postId: "p1" });
  }

  section("running · a partial success never re-posts");
  {
    await resetQueue();
    publishBehavior = (account) =>
      account.id === "x_alt" ? new Error("that one failed") : { status: "published", postId: "p" };
    const job = await addJob({ targets: ["tag:brand"], maxAttempts: 3 });
    const tick = await runDueJobs(ctx);
    check("the job counts as run", tick.ran.includes(job.id));
    const after = await getJob(job.id);
    check("it is done, not retried", after.status === "done");
    check("the partial failure is still reported",
      after.lastError.includes("x_alt"), after.lastError);
    const before = published.length;
    await runDueJobs(ctx);
    check("the account that succeeded is not posted to twice",
      published.length === before);
    publishBehavior = () => ({ status: "published", postId: "p1" });
  }

  section("running · recurrence is bounded");
  {
    await resetQueue();
    const job = await addJob({ repeat: { every: "day", interval: 1, count: 3 } });
    await runDueJobs(ctx);
    let after = await getJob(job.id);
    check("after run 1 it re-arms", after.status === "pending");
    check("run count incremented", after.runCount === 1);
    check("the next run is a day later",
      Math.round((Date.parse(after.scheduledFor) - Date.parse(job.scheduledFor)) / 86_400_000) === 1);
    check("attempts reset for the new run", after.attempts === 0);

    // Pull each occurrence into the past and fire it.
    for (let i = 2; i <= 3; i++) {
      await store.withQueueLock(async (q) => {
        q.jobs.find((j) => j.id === job.id).scheduledFor = iso(-1000);
        await store.saveQueue(q);
      });
      await runDueJobs(ctx);
    }
    after = await getJob(job.id);
    check("it stops after `count` runs", after.status === "done", after.status);
    check("it published exactly 3 times", published.length === 3, String(published.length));
  }

  section("running · crash recovery");
  {
    await resetQueue();
    const job = await addJob();
    // Simulate a process that died mid-publish, leaving the job locked.
    await store.withQueueLock(async (q) => {
      const j = q.jobs.find((x) => x.id === job.id);
      j.status = "running";
      j.lock = { pid: 999999, host: "dead-host", at: Date.now() - 60 * 60_000 };
      await store.saveQueue(q);
    });
    const tick = await runDueJobs(ctx);
    check("a stale running job is reclaimed and run", tick.ran.includes(job.id));

    await resetQueue();
    const held = await addJob();
    await store.withQueueLock(async (q) => {
      const j = q.jobs.find((x) => x.id === held.id);
      j.status = "running";
      j.lock = { pid: process.pid, host: "here", at: Date.now() };
      await store.saveQueue(q);
    });
    const tick2 = await runDueJobs(ctx);
    check("a freshly-locked job is left alone", tick2.ran.length === 0);
    check("and is not published", published.length === 0);
  }

  section("locking · concurrent ticks cannot double-post");
  {
    await resetQueue();
    await addJob({ targets: ["x_main"] });
    // Two runners racing, exactly as an MCP server and a worker would.
    const [a, b] = await Promise.all([runDueJobs(ctx), runDueJobs(ctx)]);
    check("exactly one runner claimed the job",
      a.ran.length + b.ran.length === 1, `${a.ran.length} + ${b.ran.length}`);
    check("the post went out exactly once", published.length === 1,
      String(published.length));
  }

  section("locking · the queue lock survives a crashed holder");
  {
    const { promises: fs } = await import("node:fs");
    const lockFile = `${process.env.SOCIAL_MCP_QUEUE}.lock`;
    await fs.writeFile(lockFile, "999999");
    // Backdate it beyond the staleness threshold.
    const old = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(lockFile, old, old);
    const got = await store.withQueueLock(() => "acquired");
    check("a stale lock is broken rather than deadlocking", got === "acquired");
    check("the lock file is cleaned up",
      !(await fs.stat(lockFile).catch(() => false)));
  }
  section("worker · the standalone process stays alive");
  {
    // Regression: the ticker was unref'd, and since an unresolved promise does
    // not hold Node's event loop open, --worker exited after a single tick.
    const { spawn } = await import("node:child_process");
    const { writeFile: wf } = await import("node:fs/promises");
    const queueFile = path.join(workdir, "worker-queue.json");
    await wf(queueFile, JSON.stringify({ version: 1, jobs: [] }));

    const child = spawn(process.execPath, ["dist/index.js", "--worker", "--interval", "10"], {
      env: { ...process.env, SOCIAL_MCP_QUEUE: queueFile },
      stdio: "ignore",
    });

    let exitedEarly = false;
    child.on("exit", () => { exitedEarly = true; });
    await new Promise((r) => setTimeout(r, 3000));

    check("the worker is still running after its first tick", !exitedEarly);
    check("it reports a live pid", Number.isInteger(child.pid) && !child.killed);

    const stopped = new Promise((r) => child.on("exit", (code, signal) => r(signal ?? code)));
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      stopped,
      new Promise((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    check("it shuts down on SIGTERM", outcome !== "timeout", String(outcome));
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll scheduler checks passed");
process.exit(failures ? 1 : 0);
