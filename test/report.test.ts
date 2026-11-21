import { describe, expect, it } from "vitest";
import { parseReport } from "../src/report.js";

const valid = {
  clientId: "retroquest",
  type: "bug",
  title: "Score resets when the window is resized",
  description: "Steps: start a level, resize the window.",
};

function errorField(input: unknown): string | undefined {
  const result = parseReport(input);
  return result.ok ? undefined : result.field;
}

describe("parseReport", () => {
  it("accepts a minimal report", () => {
    const result = parseReport(valid);
    expect(result).toEqual({ ok: true, report: valid });
  });

  it("accepts every optional field", () => {
    const full = {
      ...valid,
      pageUrl: "https://retroquest.rmstdope.eu/play/3",
      appVersion: "1.4.2",
      userAgent: "Mozilla/5.0",
    };
    expect(parseReport(full)).toEqual({ ok: true, report: full });
  });

  it("trims the title and folds it onto one line", () => {
    const result = parseReport({ ...valid, title: "  Score\r\nresets\t  now  " });
    expect(result.ok && result.report.title).toBe("Score resets now");
  });

  it("checks title length after folding", () => {
    expect(errorField({ ...valid, title: "  a \n " })).toBe("title");
    expect(errorField({ ...valid, title: "x".repeat(121) })).toBe("title");
    expect(errorField({ ...valid, title: "x".repeat(120) })).toBeUndefined();
  });

  it("limits the description", () => {
    expect(errorField({ ...valid, description: "   " })).toBe("description");
    expect(errorField({ ...valid, description: "x".repeat(5_001) })).toBe("description");
    expect(errorField({ ...valid, description: "x".repeat(5_000) })).toBeUndefined();
  });

  it("accepts only the three types", () => {
    for (const type of ["bug", "enhancement", "feature"]) {
      expect(errorField({ ...valid, type })).toBeUndefined();
    }
    expect(errorField({ ...valid, type: "question" })).toBe("type");
  });

  it("accepts only http and https page URLs", () => {
    expect(errorField({ ...valid, pageUrl: "javascript:alert(1)" })).toBe("pageUrl");
    expect(errorField({ ...valid, pageUrl: "not a url" })).toBe("pageUrl");
    expect(errorField({ ...valid, pageUrl: `https://a.eu/${"x".repeat(2_048)}` })).toBe("pageUrl");
    expect(errorField({ ...valid, pageUrl: "http://localhost:5173/x" })).toBeUndefined();
  });

  it("limits appVersion and userAgent", () => {
    expect(errorField({ ...valid, appVersion: "x".repeat(65) })).toBe("appVersion");
    expect(errorField({ ...valid, userAgent: "x".repeat(513) })).toBe("userAgent");
  });

  it("requires clientId, type, title and description", () => {
    for (const field of ["clientId", "type", "title", "description"]) {
      const input = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
      expect(errorField(input)).toBe(field);
    }
  });

  it("rejects unknown fields, so no contact details slip through", () => {
    expect(errorField({ ...valid, email: "a@b.c" })).toBe("email");
  });

  it("rejects input that is not an object", () => {
    expect(errorField(null)).toBe("body");
    expect(errorField([valid])).toBe("body");
    expect(errorField("report")).toBe("body");
  });
});
