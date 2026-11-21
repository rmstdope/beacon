import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const clients = {
  retroquest: { repo: "rmstdope/retroquest", origins: ["https://retroquest.rmstdope.eu"] },
};

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_APP_ID: "5861192",
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pkcs1).toString("base64"),
    BEACON_CLIENTS: JSON.stringify(clients),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads a valid environment", () => {
    const config = loadConfig(env());
    expect(config.appId).toBe("5861192");
    expect(config.port).toBe(8080);
    expect(config.clients.get("retroquest")).toEqual({
      repo: { owner: "rmstdope", name: "retroquest" },
      origins: ["https://retroquest.rmstdope.eu"],
    });
  });

  it("converts a PKCS#1 key, as GitHub issues it, to PKCS#8", () => {
    expect(loadConfig(env()).privateKeyPem).toBe(pkcs8);
  });

  it("accepts a PKCS#8 key as is", () => {
    const config = loadConfig(env({ GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pkcs8).toString("base64") }));
    expect(config.privateKeyPem).toBe(pkcs8);
  });

  it("reads PORT", () => {
    expect(loadConfig(env({ PORT: "9000" })).port).toBe(9000);
    expect(() => loadConfig(env({ PORT: "http" }))).toThrow(/PORT/);
  });

  it("names a missing variable", () => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_BASE64", "BEACON_CLIENTS"]) {
      expect(() => loadConfig(env({ [name]: undefined }))).toThrow(name);
    }
  });

  it("rejects a non-numeric app ID", () => {
    expect(() => loadConfig(env({ GITHUB_APP_ID: "abc" }))).toThrow(/GITHUB_APP_ID/);
  });

  it("rejects a key that is not a private key, without echoing it", () => {
    const secret = Buffer.from("not-a-key-SECRET").toString("base64");
    expect(() => loadConfig(env({ GITHUB_APP_PRIVATE_KEY_BASE64: secret }))).toThrow(
      /GITHUB_APP_PRIVATE_KEY_BASE64/,
    );
    expect(() => loadConfig(env({ GITHUB_APP_PRIVATE_KEY_BASE64: secret }))).not.toThrow(/SECRET/);
  });

  it("rejects BEACON_CLIENTS that is not JSON", () => {
    expect(() => loadConfig(env({ BEACON_CLIENTS: "{" }))).toThrow(/BEACON_CLIENTS/);
  });

  it("requires at least one client", () => {
    expect(() => loadConfig(env({ BEACON_CLIENTS: "{}" }))).toThrow(/BEACON_CLIENTS/);
  });

  it("validates client IDs, repositories and origins", () => {
    const bad = [
      { "Retro Quest": clients.retroquest },
      { retroquest: { ...clients.retroquest, repo: "retroquest" } },
      { retroquest: { ...clients.retroquest, repo: "rmstdope/retro quest" } },
      { retroquest: { ...clients.retroquest, origins: [] } },
      { retroquest: { ...clients.retroquest, origins: ["https://retroquest.rmstdope.eu/"] } },
      { retroquest: { ...clients.retroquest, origins: ["https://retroquest.rmstdope.eu/play"] } },
      { retroquest: { ...clients.retroquest, origins: ["ftp://retroquest.rmstdope.eu"] } },
      { retroquest: { ...clients.retroquest, extra: true } },
    ];
    for (const value of bad) {
      expect(() => loadConfig(env({ BEACON_CLIENTS: JSON.stringify(value) })), JSON.stringify(value)).toThrow(
        /BEACON_CLIENTS/,
      );
    }
  });

  it("accepts an origin with a port", () => {
    const value = { dev: { repo: "rmstdope/beacon", origins: ["http://localhost:5173"] } };
    expect(loadConfig(env({ BEACON_CLIENTS: JSON.stringify(value) })).clients.get("dev")?.origins).toEqual([
      "http://localhost:5173",
    ]);
  });
});
