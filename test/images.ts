/** Image bytes built in code for tests, so no binary fixtures are committed. */
import { crc32, deflateSync } from "node:zlib";

export const bytes = (...parts: (Uint8Array | number[] | string)[]): Uint8Array =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));

export function u32be(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

export function u32le(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngChunk(type: string, data: Uint8Array | string = new Uint8Array()): Uint8Array {
  const body = bytes(type, data);
  return bytes(u32be(body.length - 4), body, u32be(crc32(body)));
}

/** A real 1×1 red RGB PNG, with whatever extra chunks are given placed before IDAT. */
export function png(...extra: Uint8Array[]): Uint8Array {
  const ihdr = pngChunk("IHDR", bytes(u32be(1), u32be(1), [8, 2, 0, 0, 0]));
  const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0])));
  return bytes(PNG_SIGNATURE, ihdr, ...extra, idat, pngChunk("IEND"));
}
