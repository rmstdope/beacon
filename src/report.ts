import { z } from "zod";
import { stripUnsafe } from "./text.js";

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
});

export type Report = z.infer<typeof ReportSchema>;

/**
 * On failure, `field` is a schema field name, `body` or `unknown_key`: never text the caller chose,
 * so it is safe to log. `message` may quote the caller's input and goes only into the response.
 */
export type ParseResult = { ok: true; report: Report } | { ok: false; field: string; message: string };

/** Validates an untrusted request body. On failure, names the first offending field. */
export function parseReport(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, field: "body", message: "body must be a JSON object" };
  }
  const result = ReportSchema.safeParse(input);
  if (result.success) return { ok: true, report: result.data };
  const issue = result.error.issues[0];
  if (issue?.code === "unrecognized_keys") {
    const key = (issue.keys[0] ?? "").slice(0, 64);
    return { ok: false, field: "unknown_key", message: `unknown field: ${key}` };
  }
  const field = String(issue?.path[0] ?? "body");
  return { ok: false, field, message: `${field}: ${issue?.message ?? "invalid"}` };
}
