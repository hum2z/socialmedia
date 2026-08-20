#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { configPath, loadConfig, resolveTargets, updateSession } from "./config.js";
import { adapterFor } from "./platforms/index.js";
import { describeError } from "./util/errors.js";
import { debug } from "./util/logger.js";
import { runDueJobs, startTicker } from "./scheduler/runner.js";
import { dueAt, isTerminal, queuePath, withQueueLock } from "./scheduler/store.js";
import { relativeToNow } from "./scheduler/time.js";

/**
 * Loads .env files so `env:VAR` credentials resolve without the launching
 * client having to forward every secret. Node's loader never overwrites a
 * variable that is already set, so a real environment variable always wins;
 * within the files, the first one to define a name keeps it.
 */
function loadEnvFiles(): void {
  const candidates = [
    process.env.SOCIAL_MCP_ENV_FILE,
    path.join(path.dirname(configPath()), ".env"),
    path.join(process.cwd(), ".env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      process.loadEnvFile(file);
      debug(`loaded env file ${file}`);
    } catch {
      // Absent or unreadable .env files are the normal case, not an error.
    }
  }
}

/**
 * Connectivity check that runs outside MCP, so credential problems can be
 * diagnosed in a terminal rather than through a client's error surface.
 */
async function doctor(): Promise<number> {
  console.log(`social-mcp doctor`);
  console.log(`config: ${configPath()}\n`);

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`✗ config could not be loaded: ${describeError(err)}`);
    return 1;
  }

  if (!config.accounts.length) {
    console.log("No accounts configured yet.");
    console.log("Add one with the add_account tool, or create the file by hand.");
    return 0;
  }

  const ctx = { saveSession: updateSession };
  const accounts = resolveTargets(config, ["all"]);
  let failures = 0;

  for (const account of accounts) {
    process.stdout.write(`• ${account.id} (${account.platform}) … `);
    try {
      const profile = await adapterFor(account.platform).verify(ctx, account);
      const bits = [
        profile.handle,
        profile.followers !== undefined ? `${profile.followers} followers` : undefined,
        profile.quotaRemaining !== undefined
          ? `${profile.quotaRemaining} posts left today`
          : undefined,
      ].filter(Boolean);
      console.log(`ok${bits.length ? ` — ${bits.join(", ")}` : ""}`);
    } catch (err) {
      failures++;
      console.log(`FAILED\n    ${describeError(err)}`);
    }
  }

  console.log(
    `\n${accounts.length - failures}/${accounts.length} account(s) healthy.`,
  );

  try {
    const queue = await withQueueLock((q) => q);
    const pending = queue.jobs.filter((j) => !isTerminal(j.status));
    if (pending.length) {
      console.log(`\nScheduled posts (${queuePath()}):`);
      for (const job of pending.sort((a, b) => dueAt(a) - dueAt(b)).slice(0, 10)) {
        const at = job.nextAttemptAt ?? job.scheduledFor;
        console.log(
          `• ${job.id} → ${job.targets.join(", ")} at ${at} (${relativeToNow(at)})`,
        );
      }
      const overdue = pending.filter((j) => dueAt(j) < Date.now());
      if (overdue.length) {
        console.log(
          `\n${overdue.length} job(s) are already overdue. Nothing is running to fire them —\n` +
            `start the worker with:  social-mcp --worker`,
        );
      }
    }
  } catch (err) {
    console.error(`\nCould not read the scheduler queue: ${describeError(err)}`);
  }

  return failures ? 1 : 0;
}

/**
 * Standalone scheduler process. An MCP server over stdio only lives while its
 * client is connected, so unattended posting needs something that outlives it.
 * Run this under systemd, launchd, pm2 — or invoke `--run-due` from cron.
 */
async function worker(intervalMs: number): Promise<never> {
  console.error(
    `social-mcp worker started (pid ${process.pid}), checking every ${
      intervalMs / 1000
    }s`,
  );
  console.error(`queue: ${queuePath()}`);

  const ctx = { saveSession: updateSession };
  const stop = startTicker(ctx, intervalMs, { keepProcessAlive: true });

  const shutdown = (signal: string) => {
    console.error(`\nsocial-mcp worker stopping (${signal})`);
    stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Hold the process open; the ticker itself is unref'd.
  return new Promise<never>(() => {});
}

/** One-shot pass over the queue, for cron. */
async function runDueOnce(): Promise<number> {
  const ctx = { saveSession: updateSession };
  const tick = await runDueJobs(ctx);
  const summary =
    `ran ${tick.ran.length}, retrying ${tick.retrying.length}, ` +
    `failed ${tick.failed.length}, missed ${tick.missed.length}`;
  console.log(summary);
  for (const [id, results] of Object.entries(tick.results)) {
    for (const r of results as unknown as Array<{ accountId: string; status: string; url?: string; message?: string }>) {
      console.log(`  ${id} · ${r.accountId}: ${r.status}${r.url ? ` → ${r.url}` : ""}${r.message ? ` (${r.message})` : ""}`);
    }
  }
  return tick.failed.length ? 1 : 0;
}

function intervalArg(): number {
  const flag = process.argv.indexOf("--interval");
  const seconds = flag >= 0 ? Number(process.argv[flag + 1]) : NaN;
  return Number.isFinite(seconds) && seconds >= 10 ? seconds * 1000 : 60_000;
}

const HELP = `social-mcp — post to and analyze many social accounts

USAGE
  social-mcp                 run the MCP server on stdio (for Claude)
  social-mcp --worker        run the scheduler continuously in the background
  social-mcp --run-due       fire any due scheduled posts once, then exit (cron)
  social-mcp --doctor        verify every account's credentials and show the queue
  social-mcp --help          show this message

OPTIONS
  --interval <seconds>       scheduler check frequency (default 60, minimum 10)

ENVIRONMENT
  SOCIAL_MCP_CONFIG          path to accounts.json
  SOCIAL_MCP_QUEUE           path to scheduled.json
  SOCIAL_MCP_ENV_FILE        extra .env file to load
  SOCIAL_MCP_CATCH_UP_MINUTES  how late a missed post may still go out (default 120)
  SOCIAL_MCP_NO_SCHEDULER=1  don't tick the scheduler inside the MCP server
  SOCIAL_MCP_DEBUG=1         log requests to stderr

Scheduled posts only fire while something is running: the MCP server (while
Claude is connected) or --worker / --run-due. See the README for setting the
worker up under systemd, launchd or cron.
`;

async function main(): Promise<void> {
  loadEnvFiles();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (process.argv.includes("--doctor")) {
    process.exit(await doctor());
  }
  if (process.argv.includes("--run-due")) {
    process.exit(await runDueOnce());
  }
  if (process.argv.includes("--worker")) {
    await worker(intervalArg());
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Fire due posts while the client is connected. A standalone --worker is
  // still needed for anything scheduled outside a session.
  const schedulerOff = process.env.SOCIAL_MCP_NO_SCHEDULER === "1";
  if (!schedulerOff) {
    startTicker({ saveSession: updateSession }, intervalArg());
  }

  // stdout belongs to the protocol; status goes to stderr.
  console.error(
    `social-mcp ready on stdio${schedulerOff ? "" : " (scheduler ticking)"}`,
  );
}

main().catch((err) => {
  console.error(`social-mcp failed to start: ${describeError(err)}`);
  process.exit(1);
});
