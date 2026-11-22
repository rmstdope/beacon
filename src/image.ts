/**
 * Recognises PNG, JPEG and WebP images by their contents and removes embedded metadata (location,
 * device, time taken, text) without touching the picture. Anything malformed is refused rather
 * than guessed at, so what is stored is what was checked.
 */

export type ImageType = "png" | "jpeg" | "webp";
export interface CleanImage {
  type: ImageType;
  bytes: Uint8Array;
}

/** Returns the image without its metadata, or undefined when it is not a well-formed PNG, JPEG or WebP. */
export function cleanImage(input: Uint8Array): CleanImage | undefined {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (startsWith(data, PNG_SIGNATURE)) return wrap("png", cleanPng(data));
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return wrap("jpeg", cleanJpeg(data));
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return wrap("webp", cleanWebp(data));
  return undefined;
}

function wrap(type: ImageType, bytes: Uint8Array | undefined): CleanImage | undefined {
  return bytes === undefined ? undefined : { type, bytes };
}

function startsWith(data: Buffer, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((byte, i) => data[i] === byte);
}

function ascii(data: Buffer, start: number, end: number): string {
  return data.toString("latin1", start, end);
}

// --- PNG ---------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks the picture depends on: the critical ones, colour, transparency, density, animation. */
const PNG_KEEP = new Set([
  "IHDR", "PLTE", "IDAT", "IEND",
  "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "cICP", "mDCV", "cLLI", "pHYs", "bKGD", "hIST", "sPLT",
  "acTL", "fcTL", "fdAT",
]);

/** Copies the kept chunks whole (CRCs included); ignores anything after IEND. */
function cleanPng(data: Buffer): Uint8Array | undefined {
  const kept: Buffer[] = [data.subarray(0, 8)];
  let at = 8;
  let first = true;
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > data.length) return undefined;
    const type = ascii(data, at + 4, at + 8);
    if (first && type !== "IHDR") return undefined;
    first = false;
    if (PNG_KEEP.has(type)) kept.push(data.subarray(at, end));
    if (type === "IEND") return changed(data, kept);
    at = end;
  }
  return undefined;
}

/** The original buffer when nothing was dropped, so an image without metadata is stored as sent. */
function changed(data: Buffer, kept: Buffer[]): Uint8Array {
  const out = Buffer.concat(kept);
  return out.equals(data) ? data : out;
}

// --- JPEG --------------------------------------------------------------------------------------

const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;

/** Markers that stand alone, with no length: TEM and the restart markers. */
function standalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Keeps APP0 (JFIF), APP2 ICC profiles, APP14 Adobe (the colour transform) and every non-APP,
 * non-comment segment, including the scans; drops the other APPn segments and comments wherever
 * they sit, and anything after EOI. A non-default EXIF orientation survives as a minimal APP1.
 */
function cleanJpeg(data: Buffer): Uint8Array | undefined {
  const kept: Buffer[] = [data.subarray(0, 2)];
  let orientation: number | undefined;
  let orientationAt: number | undefined;
  let sawScan = false;
  let at = 2;
  while (at < data.length) {
    if (data[at] !== 0xff) return undefined;
    let markerAt = at;
    while (data[markerAt + 1] === 0xff) markerAt++; // fill bytes
    const marker = data[markerAt + 1];
    if (marker === undefined) return undefined;
    if (marker === EOI) {
      if (!sawScan) return undefined;
      kept.push(data.subarray(markerAt, markerAt + 2));
      if (orientation !== undefined && orientationAt !== undefined) {
        kept.splice(orientationAt, 0, orientationSegment(orientation));
      }
      return changed(data, kept);
    }
    if (standalone(marker)) {
      kept.push(data.subarray(markerAt, markerAt + 2));
      at = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > data.length) return undefined;
    const length = data.readUInt16BE(markerAt + 2);
    let end = markerAt + 2 + length;
    if (length < 2 || end > data.length) return undefined;
    const payload = data.subarray(markerAt + 4, end);
    if (marker === SOS) {
      sawScan = true;
      end = scanEnd(data, end);
    }
    if (keepJpegSegment(marker, payload)) {
      kept.push(data.subarray(markerAt, end));
    } else if (marker === APP1 && orientation === undefined) {
      const found = exifOrientation(payload);
      if (found !== undefined && found >= 2 && found <= 8) {
        orientation = found;
        orientationAt = kept.length;
      }
    }
    at = end;
  }
  return undefined;
}

function keepJpegSegment(marker: number, payload: Buffer): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker < 0xe0 || marker > 0xef) return true;
  if (marker === 0xe0) return ascii(payload, 0, 5) === "JFIF\0";
  if (marker === 0xe2) return ascii(payload, 0, 12) === "ICC_PROFILE\0";
  if (marker === 0xee) return ascii(payload, 0, 5) === "Adobe";
  return false;
}

/** Where entropy-coded data after a scan header ends: at the next marker that is not a restart. */
function scanEnd(data: Buffer, from: number): number {
  let at = from;
  while (at + 1 < data.length) {
    const next = data[at + 1] ?? 0;
    if (data[at] === 0xff && next !== 0 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) return at;
    at++;
  }
  return data.length;
}

/** Reads Orientation (0x0112) from IFD0 of an `Exif\0\0` APP1 payload; undefined if absent or unreadable. */
function exifOrientation(payload: Buffer): number | undefined {
  if (ascii(payload, 0, 6) !== "Exif\0\0") return undefined;
  const tiff = payload.subarray(6);
  if (tiff.length < 8) return undefined;
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) return u16(entry + 8);
  }
  return undefined;
}

/** An APP1 segment whose EXIF holds only the Orientation tag, big-endian. */
function orientationSegment(orientation: number): Buffer {
  const payload = Buffer.from([
    ...Buffer.from("Exif\0\0MM\0*", "latin1"),
    0, 0, 0, 8, // IFD0 offset
    0, 1, // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation, SHORT, 1
    0, 0, 0, 0, // no next IFD
  ]);
  const header = Buffer.from([0xff, APP1, 0, payload.length + 2]);
  return Buffer.concat([header, payload]);
}

// --- WebP --------------------------------------------------------------------------------------

/** Chunks the picture depends on; EXIF, XMP and unknown chunks are dropped. */
const WEBP_KEEP = new Set(["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);
const WEBP_IMAGE = new Set(["VP8 ", "VP8L", "ANMF"]);
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;

function cleanWebp(data: Buffer): Uint8Array | undefined {
  const riffEnd = 8 + data.readUInt32LE(4);
  if (riffEnd > data.length || riffEnd % 2 !== 0) return undefined;
  const kept: Buffer[] = [];
  let hasImage = false;
  let at = 12;
  while (at < riffEnd) {
    if (at + 8 > riffEnd) return undefined;
    const fourcc = ascii(data, at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > riffEnd) return undefined;
    if (WEBP_IMAGE.has(fourcc)) hasImage = true;
    if (WEBP_KEEP.has(fourcc)) {
      const chunk = Buffer.from(data.subarray(at, end));
      if (fourcc === "VP8X" && size >= 1) chunk[8] = (chunk[8] ?? 0) & ~(EXIF_FLAG | XMP_FLAG);
      kept.push(chunk);
    }
    at = end;
  }
  if (!hasImage) return undefined;
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...kept]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return changed(data, [header, body]);
}
