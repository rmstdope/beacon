import { describe, expect, it } from "vitest";
import { parseReport } from "../src/report.js";
import { bytes, png, pngChunk } from "./images.js";

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
    const result = parseReport({ ...valid, email: "a@b.c" });
    expect(result).toMatchObject({ ok: false, field: "unknown_key" });
    expect(!result.ok && result.message).toContain("email");
  });

  it("caps an unknown key's name in the message", () => {
    const result = parseReport({ ...valid, ["k".repeat(5_000)]: 1 });
    expect(!result.ok && result.message.length).toBeLessThan(200);
  });

  it("strips control and invisible characters before checking lengths", () => {
    expect(errorField({ ...valid, title: "\u0001\u0002\u0003" })).toBe("title");
    expect(errorField({ ...valid, title: "\u202E\u202E\u202E" })).toBe("title");
    expect(errorField({ ...valid, description: "\u0000\u200B\u{E0041}" })).toBe("description");
  });

  it("strips C0, C1, format and tag characters, keeping tabs and line breaks", () => {
    const hidden = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e); // tag characters: invisible text
    const result = parseReport({
      ...valid,
      title: "Score\u0085 re\u200Dsets\u00AD now" + hidden,
      description: "a\r\nb\tc\u0080\u2060\u200Ed\uFEFF" + hidden,
    });
    expect(result.ok && result.report.title).toBe("Score resets now");
    expect(result.ok && result.report.description).toBe("a\nb\tcd");
  });

  it("folds whitespace after stripping, so no double spaces remain", () => {
    const result = parseReport({ ...valid, title: "a \u0001 bc" });
    expect(result.ok && result.report.title).toBe("a bc");
  });

  it("rejects input that is not an object", () => {
    expect(errorField(null)).toBe("body");
    expect(errorField([valid])).toBe("body");
    expect(errorField("report")).toBe("body");
  });
});

const shot = (image: Uint8Array = png()) => ({ data: Buffer.from(image).toString("base64") });
const MiB = 1024 * 1024;

/** A PNG of exactly `size` bytes: padding goes in a private chunk, which cleaning drops. */
function pngOfSize(size: number): Uint8Array {
  const base = png();
  return png(pngChunk("prVt", new Uint8Array(size - base.length - 12)));
}

describe("parseReport: screenshots", () => {
  it("leaves screenshots out when none are sent, or the list is empty", () => {
    expect(parseReport(valid)).toEqual({ ok: true, report: valid });
    expect(parseReport({ ...valid, screenshots: [] })).toEqual({ ok: true, report: valid });
  });

  it("decodes each screenshot, in order, into a clean image", () => {
    const withText = png(pngChunk("tEXt", "GPS\0home"));
    const result = parseReport({ ...valid, screenshots: [shot(withText), shot()] });
    expect(result).toEqual({
      ok: true,
      report: { ...valid, screenshots: [{ type: "png", bytes: png() }, { type: "png", bytes: png() }] },
    });
  });

  it("accepts three and refuses four", () => {
    expect(parseReport({ ...valid, screenshots: [shot(), shot(), shot()] }).ok).toBe(true);
    expect(parseReport({ ...valid, screenshots: [shot(), shot(), shot(), shot()] })).toEqual({
      ok: false, status: 400, error: "invalid_report", field: "screenshots", message: "screenshots: at most 3",
    });
  });

  it("refuses a screenshot that is not base64, naming it from 1", () => {
    for (const data of ["not base64!", "abc", "data:image/png;base64,iVBORw0KGgo=", "QUJD\nRA=="]) {
      expect(parseReport({ ...valid, screenshots: [shot(), { data }] })).toEqual({
        ok: false, status: 400, error: "invalid_report", field: "screenshots", message: "screenshots[2]: not base64",
      });
    }
  });

  it("refuses a screenshot over 2 MB decoded, and accepts one of exactly 2 MB", () => {
    expect(parseReport({ ...valid, screenshots: [shot(pngOfSize(2 * MiB))] }).ok).toBe(true);
    expect(parseReport({ ...valid, screenshots: [shot(), shot(), shot(pngOfSize(2 * MiB + 1))] })).toEqual({
      ok: false, status: 413, error: "too_large", field: "screenshots", message: "screenshots[3]: over 2 MB",
    });
  });

  it("refuses content that is not a PNG, JPEG or WebP image", () => {
    for (const image of [bytes("GIF89a\x01\0\x01\0"), bytes("<svg/>"), new Uint8Array()]) {
      expect(parseReport({ ...valid, screenshots: [shot(image)] })).toEqual({
        ok: false,
        status: 415,
        error: "unsupported_media_type",
        field: "screenshots",
        message: "screenshots[1]: not a PNG, JPEG or WebP image",
      });
    }
  });

  it("answers the first failing screenshot, checking base64, then size, then type", () => {
    const result = parseReport({ ...valid, screenshots: [shot(bytes("GIF89a")), { data: "!" }] });
    expect(result).toMatchObject({ status: 415, message: "screenshots[1]: not a PNG, JPEG or WebP image" });
  });

  it("refuses screenshots that are not objects with a string data field", () => {
    expect(parseReport({ ...valid, screenshots: "x" })).toMatchObject({ ok: false, status: 400, field: "screenshots" });
    expect(parseReport({ ...valid, screenshots: [{ data: 1 }] })).toMatchObject({ ok: false, field: "screenshots" });
    expect(parseReport({ ...valid, screenshots: [{ data: "", name: "a.png" }] })).toMatchObject({
      ok: false, status: 400, field: "unknown_key",
    });
  });

  it("gives every other refusal status 400 and error invalid_report", () => {
    expect(parseReport({ ...valid, type: "question" })).toMatchObject({ status: 400, error: "invalid_report" });
  });
});
