/**
 * Control characters (C0 and C1) and format characters: bidirectional overrides and marks,
 * zero-width characters, soft hyphens, byte-order marks and the Unicode tag block. Tag
 * characters are invisible to people but read by language models, so they can hide instructions
 * from maintainers while steering an agent. One cost: emoji joined with U+200D come apart.
 */
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;

/** Normalises line endings and removes unsafe characters, keeping tabs and line feeds. */
export function stripUnsafe(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE, (char) => (char === "\t" || char === "\n" ? char : ""));
}
