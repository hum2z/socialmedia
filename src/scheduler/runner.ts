import os from "node:os";
import { loadConfig } from "../config.js";
import { executePublish, prepareTargets } from "../publish.js";
import type { AdapterContext } from "../platforms/base.js";
import { describeError } from "../util/errors.js";
import { debug, warn } from "../util/logger.js";
import {
  dueAt,
  isTerminal,
  nextOccurrence,
  saveQueue,
  withQueueLock,
  type ScheduledJob,
} from "./store.js";

/**
 * How late a post may go out. A job whose time passed while nothing was
 * running is marked "missed" rather than published hours late — a 9am
 * announcement landing at 6pm is usually worse than not landing at all.
 */
const DEFAULT_CATCH_UP_MINUTES = 120;

/** A job left "running" by a process that died is reclaimed after this long. */
const STALE_LOCK_MS = 15 * 60 * 1000;

function catchUpWindowMs(): number {
  const raw = Number(process.env.SOCIAL_MCP_CATCH_UP_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CATCH_UP_MINUTES;
  return minutes * 60_000;
}

/** Exponential backoff between publish attempts: 5min, 10min, 20min… */
const retryDelayMs = (attempts: number) =>
  Math.min(5 * 60_000 * 2 ** (attempts - 1), 60 * 60_000);

export interface TickResult {
  ran: string[];
  missed: string[];
  retrying: string[];
  failed: string[];
  results: Record<string, ReturnType<typeof describeError>[]>;
}

/**
 * Claims every job that is due, under the queue lock, so two processes never
 * take the same one. Claiming and executing are deliberately separate: the
 * lock is held only for the fast bookkeeping, never across a media upload.
 */
async function claimDueJobs(now: number): Promise<{
  claimed: ScheduledJob[];
  missed: ScheduledJob[];
}> {
  return withQueueLock(async (queue) => {
    const claimed: ScheduledJob[] = [];
    const missed: ScheduledJob[] = [];
    const window = catchUpWindowMs();

    for (const job of queue.jobs) {
      if (isTerminal(job.status)) continue;

      if (job.status === "running") {
        const heldFor = now - (job.lock?.at ?? 0);
        if (heldFor < STALE_LOCK_MS) continue;
        debug(`reclaiming stale job ${job.id}`);
        job.status = "pending";
        delete job.lock;
      }

      const due = dueAt(job);
      if (!Number.isFinite(due) || due > now) continue;

      // Only a genuinely scheduled time can go stale; a retry backoff cannot.
      if (!job.nextAttemptAt && now - due > window) {
        job.status = "missed";
        job.finishedAt = new Date(now).toISOString();
        job.lastError =
          `Its scheduled time passed ${Math.round((now - due) / 60_000)} minutes ago, ` +
          `beyond the ${window / 60_000}-minute catch-up window, so it was not posted.`;
        missed.push(job);
        continue;
      }

      job.status = "running";
      job.attempts += 1;
      job.lock = { pid: process.pid, host: os.hostname(), at: now };
      claimed.push(structuredClone(job));
    }

    if (claimed.length || missed.length) await saveQueue(queue);
    return { claimed, missed };
  });
}

/** Writes the outcome of one finished job back into the queue. */
async function settleJob(
  id: string,
  outcome: (job: ScheduledJob) => void,
): Promise<void> {
  await withQueueLock(async (queue) => {
    const job = queue.jobs.find((j) => j.id === id);
    if (!job) return;
    delete job.lock;
    outcome(job);
    await saveQueue(queue);
  });
}

/**
 * Runs every due job once. Safe to call repeatedly and from more than one
 * process; the queue lock makes double-posting impossible.
 */
export async function runDueJobs(
  ctx: AdapterContext,
  opts: { now?: number } = {},
): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const { claimed, missed } = await claimDueJobs(now);
  const tick: TickResult = {
    ran: [],
    missed: missed.map((j) => j.id),
    retrying: [],
    failed: [],
    results: {},
  };

  for (const job of claimed) {
    let published;
    try {
      const config = await loadConfig();
      const prepared = prepareTargets(config, job.targets, job.content, job.overrides);
      published = await executePublish(prepared, ctx, { skipInvalid: true });
    } catch (err) {
      // A whole-job failure: bad targets, unreadable config, and so on.
      const message = describeError(err);
      await settleJob(job.id, (j) => {
        if (j.attempts >= j.maxAttempts) {
          j.status = "failed";
          j.finishedAt = new Date().toISOString();
        } else {
          j.status = "pending";
          j.nextAttemptAt = new Date(now + retryDelayMs(j.attempts)).toISOString();
        }
        j.lastError = message;
      });
      (job.attempts >= job.maxAttempts ? tick.failed : tick.retrying).push(job.id);
      warn(`scheduled job ${job.id} failed: ${message}`);
      continue;
    }

    const failures = published.filter((r) => r.status === "failed");
    const succeeded = published.length - failures.length;

    await settleJob(job.id, (j) => {
      j.results = published;
      j.lastError = failures.length
        ? failures.map((f) => `${f.accountId}: ${f.message}`).join(" | ")
        : undefined;
      delete j.nextAttemptAt;

      // Retry only when nothing at all got out; a partial success must not
      // re-post to the accounts that already succeeded.
      if (succeeded === 0 && j.attempts < j.maxAttempts) {
        j.status = "pending";
        j.nextAttemptAt = new Date(now + retryDelayMs(j.attempts)).toISOString();
        return;
      }
      if (succeeded === 0) {
        j.status = "failed";
        j.finishedAt = new Date().toISOString();
        return;
      }

      const next = nextOccurrence(j);
      if (next) {
        j.runCount = (j.runCount ?? 0) + 1;
        j.scheduledFor = next;
        j.status = "pending";
        j.attempts = 0;
        return;
      }
      j.status = "done";
      j.finishedAt = new Date().toISOString();
    });

    if (succeeded === 0) {
      (job.attempts >= job.maxAttempts ? tick.failed : tick.retrying).push(job.id);
    } else {
      tick.ran.push(job.id);
    }
    tick.results[job.id] = published as never;
  }

  return tick;
}

/**
 * Fires due jobs on an interval for as long as this process lives.
 *
 * `keepProcessAlive` decides whether the timer holds the event loop open. The
 * MCP server sets it false — its stdio transport already keeps the process up,
 * and an unref'd timer lets it exit cleanly when the client disconnects. The
 * standalone worker sets it true: the timer is the only thing running, so
 * unref'ing it would make the process exit after a single tick.
 */
export function startTicker(
  ctx: AdapterContext,
  intervalMs = 60_000,
  { keepProcessAlive = false }: { keepProcessAlive?: boolean } = {},
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const result = await runDueJobs(ctx);
      if (result.ran.length || result.failed.length || result.missed.length) {
        warn(
          `scheduler: ${result.ran.length} ran, ${result.retrying.length} retrying, ` +
            `${result.failed.length} failed, ${result.missed.length} missed`,
        );
      }
    } catch (err) {
      warn(`scheduler tick failed: ${describeError(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (!keepProcessAlive) timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
