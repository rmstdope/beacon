import { z } from "zod";
import { cleanImage, type CleanImage } from "./image.js";
import { stripUnsafe } from "./text.js";

export const MAX_SCREENSHOTS = 3;
/** Decoded bytes per screenshot: 2 MiB. */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export const REPORT_TYPES = ["bug", "enhancement", "feature"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Strips unsafe characters, then folds onto one line and trims. */
function cleanLine(value: string): string {
  return stripUnsafe(value).replace(/\s+/g, " ").trim();
}

const pageUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http or https URL");

/** Lengths are checked after unsafe characters are removed, on what will actually be filed. */
const ReportSchema = z.strictObject({
  clientId: z.string().min(1).max(64),
  type: z.enum(REPORT_TYPES),
  title: z.string().transform(cleanLine).pipe(z.string().min(3).max(120)),
  description: z
    .string()
    .transform(stripUnsafe)
    .pipe(z.string().max(5_000).refine((value) => value.trim().length > 0, "must not be empty")),
  pageUrl: pageUrl.optional(),
  appVersion: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
  screenshots: z.array(z.strictObject({ data: z.string() })).max(MAX_SCREENSHOTS, "at most 3").optional(),
});

/** A report as validated: screenshots are decoded and cleaned, and absent when none were sent. */
export type Report = Omit<z.infer<typeof ReportSchema>, "screenshots"> & { screenshots?: CleanImage[] };

/**
 * On failure, `field` is a schema field name, `body` or `unknown_key`: never text the caller chose,
 * so it is safe to log. `message` may quote the caller's input and goes only into the response.
 */
export type ParseResult =
  | { ok: true; report: Report }
  | {
      ok: false;
      status: 400 | 413 | 415;
      error: "invalid_report" | "too_large" | "unsupported_media_type";
      field: string;
      message: string;
    };

type Failure = Extract<ParseResult, { ok: false }>;

function invalid(field: string, message: string): Failure {
  return { ok: false, status: 400, error: "invalid_report", field, message };
}

/** Standard base64 with padding: no whitespace, no `data:` prefix, no URL-safe alphabet. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The decoded length of valid base64, known before decoding it. */
function decodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** Checks each screenshot in order (base64, then size, then type) and cleans it; N counts from 1. */
function parseScreenshots(screenshots: { data: string }[]): CleanImage[] | Failure {
  const images: CleanImage[] = [];
  for (const [index, { data }] of screenshots.entries()) {
    const name = `screenshots[${String(index + 1)}]`;
    if (!BASE64.test(data)) return invalid("screenshots", `${name}: not base64`);
    if (decodedLength(data) > MAX_SCREENSHOT_BYTES) {
      return { ok: false, status: 413, error: "too_large", field: "screenshots", message: `${name}: over 2 MB` };
    }
    const image = cleanImage(Buffer.from(data, "base64"));
    if (image === undefined) {
      return {
        ok: false,
        status: 415,
        error: "unsupported_media_type",
        field: "screenshots",
        message: `${name}: not a PNG, JPEG or WebP image`,
      };
    }
    images.push(image);
  }
  return images;
}

/** Validates an untrusted request body. On failure, names the first offending field. */
export function parseReport(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("body", "body must be a JSON object");
  }
  const result = ReportSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      const key = (issue.keys[0] ?? "").slice(0, 64);
      return invalid("unknown_key", `unknown field: ${key}`);
    }
    const field = String(issue?.path[0] ?? "body");
    return invalid(field, `${field}: ${issue?.message ?? "invalid"}`);
  }
  const { screenshots, ...report } = result.data;
  if (screenshots === undefined || screenshots.length === 0) return { ok: true, report };
  const images = parseScreenshots(screenshots);
  if (!Array.isArray(images)) return images;
  return { ok: true, report: { ...report, screenshots: images } };
}
