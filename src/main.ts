import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { GitHubAppFiler } from "./github.js";
import { FixedWindowLimiter } from "./rate-limit.js";
import { createApp, type LogEntry } from "./server.js";

type Level = "info" | "warn" | "error";

function log(level: Level, entry: LogEntry): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, ...entry });
  if (level === "info") console.log(line);
  else console.error(line);
}

/** The revision baked into the image, if any. */
function readRevision(path: string): string | undefined {
  try {
    const { revision } = JSON.parse(readFileSync(path, "utf8")) as { revision?: unknown };
    return typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

/** Warns about configured repositories the App cannot file into. Never stops the service. */
async function checkInstallations(config: Config, filer: GitHubAppFiler): Promise<void> {
  const repos = new Map([...config.clients.values()].map((c) => [`${c.repo.owner}/${c.repo.name}`, c.repo]));
  for (const [name, repo] of repos) {
    try {
      if (!(await filer.isInstalled(repo))) {
        log("warn", { event: "startup.not_installed", repo: name });
      }
    } catch (error) {
      log("warn", { event: "startup.check_failed", repo: name, reason: error instanceof Error ? error.message : "unknown" });
    }
  }
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", { event: "startup.invalid_config", reason: error.message });
      process.exit(1);
    }
    throw error;
  }

  const filer = new GitHubAppFiler({ appId: config.appId, privateKeyPem: config.privateKeyPem });
  const revision = readRevision(process.env.BEACON_RELEASE_FILE ?? "/app/release.json");
  const app = createApp({
    clients: config.clients,
    filer,
    ipLimiter: new FixedWindowLimiter({ limit: 5, windowMs: 10 * 60_000 }),
    clientLimiter: new FixedWindowLimiter({ limit: 50, windowMs: 60 * 60_000 }),
    revision,
    log: (entry) => {
      log(entry.event.endsWith("failed") ? "warn" : "info", entry);
    },
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    log("info", {
      event: "startup.listening",
      port: info.port,
      clients: config.clients.size,
      revision: revision ?? "none",
    });
  });
  void checkInstallations(config, filer);

  const shutdown = (signal: string) => {
    log("info", { event: "shutdown", signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main();
