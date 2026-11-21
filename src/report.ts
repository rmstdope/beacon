import { z } from "zod";

export const REPORT_TYPES = ["bug", "enhancement", "feature"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Folds a title onto one line and trims it. */
function foldLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

const ReportSchema = z.strictObject({
  clientId: z.string().min(1).max(64),
  type: z.enum(REPORT_TYPES),
  title: z.string().transform(foldLine).pipe(z.string().min(3).max(120)),
  description: z.string().refine((value) => value.trim().length > 0, "must not be empty").pipe(z.string().max(5_000)),
  pageUrl: pageUrl.optional(),
  appVersion: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
});

export type Report = z.infer<typeof ReportSchema>;

export type ParseResult = { ok: true; report: Report } | { ok: false; field: string; message: string };

/** Validates an untrusted request body. On failure, names the first offending field. */
export function parseReport(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, field: "body", message: "body must be a JSON object" };
  }
  const result = ReportSchema.safeParse(input);
  if (result.success) return { ok: true, report: result.data };
  const issue = result.error.issues[0];
  const field =
    issue?.code === "unrecognized_keys" ? (issue.keys[0] ?? "body") : String(issue?.path[0] ?? "body");
  return { ok: false, field, message: `${field}: ${issue?.message ?? "invalid"}` };
}
