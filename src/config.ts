import { createPrivateKey } from "node:crypto";
import { z } from "zod";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface Client {
  repo: RepoRef;
  origins: string[];
}

export interface Config {
  appId: string;
  /** The App's private key, PKCS#8 PEM. */
  privateKeyPem: string;
  clients: Map<string, Client>;
  port: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** `scheme://host[:port]` exactly, as a browser sends it in `Origin`. */
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}, "must be an exact http(s) origin, with no path or trailing slash");

const ClientsSchema = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "client IDs are lowercase letters, digits and hyphens"),
    z.strictObject({
      repo: z.string().refine((value) => {
        const parts = value.split("/");
        return parts.length === 2 && parts.every((part) => NAME.test(part) && part !== "." && part !== "..");
      }, "must be owner/name"),
      origins: z.array(origin).min(1),
    }),
  )
  .refine((value) => Object.keys(value).length > 0, "must configure at least one client");

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new ConfigError(`${name} is not set`);
  return value.trim();
}

function loadPrivateKey(base64: string): string {
  try {
    const pem = Buffer.from(base64, "base64").toString("utf8");
    return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    // Never echo the value or the parser's message: either could carry key material.
    throw new ConfigError("GITHUB_APP_PRIVATE_KEY_BASE64 is not a base64-encoded PEM private key");
  }
}

function loadClients(json: string): Map<string, Client> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError("BEACON_CLIENTS is not valid JSON");
  }
  const result = ClientsSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new ConfigError(`BEACON_CLIENTS is invalid${where}: ${issue?.message ?? "invalid"}`);
  }
  return new Map(
    Object.entries(result.data).map(([id, client]) => {
      const [owner = "", name = ""] = client.repo.split("/");
      return [id, { repo: { owner, name }, origins: client.origins }];
    }),
  );
}

/** Reads and validates the environment. Throws a ConfigError naming the variable at fault. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const appId = required(env, "GITHUB_APP_ID");
  if (!/^\d+$/.test(appId)) throw new ConfigError("GITHUB_APP_ID must be a number");
  const privateKeyPem = loadPrivateKey(required(env, "GITHUB_APP_PRIVATE_KEY_BASE64"));
  const clients = loadClients(required(env, "BEACON_CLIENTS"));
  const portText = env.PORT?.trim() || "8080";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) {
    throw new ConfigError("PORT must be a port number");
  }
  return { appId, privateKeyPem, clients, port };
}
