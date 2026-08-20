#!/usr/bin/env node
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { configPath, loadConfig, resolveTargets, updateSession } from "./config.js";
import { adapterFor } from "./platforms/index.js";
import { describeError } from "./util/errors.js";
import { debug } from "./util/logger.js";

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
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  loadEnvFiles();

  if (process.argv.includes("--doctor")) {
    process.exit(await doctor());
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; status goes to stderr.
  console.error("social-mcp ready on stdio");
}

main().catch((err) => {
  console.error(`social-mcp failed to start: ${describeError(err)}`);
  process.exit(1);
});
