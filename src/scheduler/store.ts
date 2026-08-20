import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configPath } from "../config.js";
import type { PostContent, PublishResult } from "../types.js";
import { ConfigError } from "../util/errors.js";
import { debug } from "../util/logger.js";

export type JobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  /** Its time passed while nothing was running to fire it. */
  | "missed";

export interface Repeat {
  every: "hour" | "day" | "week";
  /** Fire every N units. Default 1. */
  interval?: number;
  /** Hard stop: total number of runs, including the first. */
  count: number;
}

export interface ScheduledJob {
  id: string;
  createdAt: string;
  /** Absolute instant this job is due, always stored as UTC ISO-8601. */
  scheduledFor: string;
  /** Echoes what the user asked for, so listings can show their wording. */
  requestedTime?: string;
  targets: string[];
  content: PostContent;
  overrides?: Record<string, Partial<PostContent>>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  repeat?: Repeat;
  /** Runs already completed for a repeating job. */
  runCount?: number;
  /** Set when a failed attempt is backing off; overrides scheduledFor while set. */
  nextAttemptAt?: string;
  lastError?: string;
  results?: PublishResult[];
  finishedAt?: string;
  note?: string;
  /** Set while a process is executing this job; cleared when it finishes. */
  lock?: { pid: number; host: string; at: number };
}

export interface Queue {
  version: 1;
  jobs: ScheduledJob[];
}

const EMPTY: Queue = { version: 1, jobs: [] };

/** The queue sits beside the account registry. */
export function queuePath(): string {
  const override = process.env.SOCIAL_MCP_QUEUE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(path.dirname(configPath()), "scheduled.json");
}

export async function loadQueue(): Promise<Queue> {
  try {
    const raw = await fs.readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw) as Queue;
    if (!Array.isArray(parsed?.jobs)) return structuredClone(EMPTY);
    return { version: 1, jobs: parsed.jobs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY);
    }
    if (err instanceof SyntaxError) {
      throw new ConfigError(
        `${queuePath()} is not valid JSON: ${err.message}. ` +
          `Fix or delete the file — scheduled posts are stored there.`,
      );
    }
    throw err;
  }
}

export async function saveQueue(queue: Queue): Promise<void> {
  const file = queuePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(queue, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmp, file);
}

/**
 * Serializes read-modify-write against the queue file. The MCP server and a
 * standalone worker can both be running, and without this they could each
 * claim the same job and post twice.
 */
export async function withQueueLock<T>(fn: (queue: Queue) => Promise<T> | T): Promise<T> {
  const lockFile = `${queuePath()}.lock`;
  await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + 10_000;
  let handle: fs.FileHandle | undefined;

  while (!handle) {
    try {
      handle = await fs.open(lockFile, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Break a lock left behind by a process that died mid-write.
      const stale = await fs
        .stat(lockFile)
        .then((s) => Date.now() - s.mtimeMs > 60_000)
        .catch(() => false);
      if (stale) {
        debug("removing stale queue lock");
        await fs.rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ConfigError(
          `Timed out waiting for the scheduler lock at ${lockFile}. ` +
            `Another process may be busy; remove the file if nothing is running.`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    await handle.write(String(process.pid));
    const queue = await loadQueue();
    return await fn(queue);
  } finally {
    await handle.close();
    await fs.rm(lockFile, { force: true });
  }
}

export function newJob(input: {
  scheduledFor: string;
  requestedTime?: string;
  targets: string[];
  content: PostContent;
  overrides?: Record<string, Partial<PostContent>>;
  maxAttempts?: number;
  repeat?: Repeat;
  note?: string;
}): ScheduledJob {
  return {
    id: `sched_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    scheduledFor: input.scheduledFor,
    requestedTime: input.requestedTime,
    targets: input.targets,
    content: input.content,
    overrides: input.overrides,
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    repeat: input.repeat,
    runCount: 0,
    note: input.note,
  };
}

/** Next occurrence for a repeating job, or undefined when it has run out. */
export function nextOccurrence(job: ScheduledJob): string | undefined {
  if (!job.repeat) return undefined;
  const runs = (job.runCount ?? 0) + 1;
  if (runs >= job.repeat.count) return undefined;

  const interval = Math.max(1, job.repeat.interval ?? 1);
  const next = new Date(job.scheduledFor);
  if (job.repeat.every === "hour") next.setUTCHours(next.getUTCHours() + interval);
  else if (job.repeat.every === "day") next.setUTCDate(next.getUTCDate() + interval);
  else next.setUTCDate(next.getUTCDate() + 7 * interval);
  return next.toISOString();
}

/** The instant a job should next be attempted. */
export const dueAt = (job: ScheduledJob): number =>
  Date.parse(job.nextAttemptAt ?? job.scheduledFor);

export const isTerminal = (status: JobStatus) =>
  status === "done" || status === "cancelled" || status === "failed" || status === "missed";
