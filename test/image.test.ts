import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cleanImage } from "../src/image.js";

const bytes = (...parts: (Uint8Array | number[] | string)[]): Uint8Array =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));

function u32be(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function u32le(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

// --- PNG ---------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type: string, data: Uint8Array | string = new Uint8Array()): Uint8Array {
  const body = bytes(type, typeof data === "string" ? data : data);
  return bytes(u32be(body.length - 4), body, u32be(crc32(body)));
}

/** A real 1×1 red RGB PNG, with whatever extra chunks are given placed before IDAT. */
function png(...extra: Uint8Array[]): Uint8Array {
  const ihdr = pngChunk("IHDR", bytes(u32be(1), u32be(1), [8, 2, 0, 0, 0]));
  const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0])));
  return bytes(PNG_SIGNATURE, ihdr, ...extra, idat, pngChunk("IEND"));
}

function pngChunkTypes(image: Uint8Array): string[] {
  const types: string[] = [];
  for (let at = 8; at < image.length; ) {
    const length = Buffer.from(image).readUInt32BE(at);
    types.push(Buffer.from(image.subarray(at + 4, at + 8)).toString("latin1"));
    at += 12 + length;
  }
  return types;
}

describe("cleanImage: PNG", () => {
  it("passes a PNG without metadata through unchanged", () => {
    const image = png();
    expect(cleanImage(image)).toEqual({ type: "png", bytes: image });
  });

  it("removes text, EXIF, time and private chunks, keeping what the picture needs", () => {
    const image = png(
      pngChunk("gAMA", bytes(u32be(45455))),
      pngChunk("sRGB", bytes([0])),
      pngChunk("tEXt", "GPS\0Stockholm 59.3N"),
      pngChunk("zTXt", "Author\0\0x"),
      pngChunk("iTXt", "Device\0\0\0\0\0iPhone"),
      pngChunk("eXIf", "MM\0*secret"),
      pngChunk("tIME", bytes([7, 234, 11, 22, 12, 0, 0])),
      pngChunk("prVt", "private"),
      pngChunk("pHYs", bytes(u32be(2835), u32be(2835), [1])),
    );
    const result = cleanImage(image);
    expect(result?.type).toBe("png");
    expect(pngChunkTypes(result?.bytes ?? new Uint8Array())).toEqual(["IHDR", "gAMA", "sRGB", "pHYs", "IDAT", "IEND"]);
    expect(Buffer.from(result?.bytes ?? []).toString("latin1")).not.toContain("Stockholm");
  });

  it("refuses a truncated PNG or one whose first chunk is not IHDR", () => {
    const image = png();
    expect(cleanImage(image.subarray(0, image.length - 5))).toBeUndefined();
    expect(cleanImage(bytes(PNG_SIGNATURE, pngChunk("IEND")))).toBeUndefined();
    expect(cleanImage(bytes(PNG_SIGNATURE))).toBeUndefined();
  });

  it("refuses a PNG that does not end with IEND", () => {
    const image = png();
    expect(cleanImage(image.subarray(0, image.length - 12))).toBeUndefined();
  });
});

// --- JPEG --------------------------------------------------------------------------------------

function segment(marker: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? Buffer.from(payload, "latin1") : payload;
  return bytes([0xff, marker, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255], body);
}

/** EXIF with IFD0 holding Orientation, a Make string and a GPS pointer, in either byte order. */
function exif(orientation: number, littleEndian = false): Uint8Array {
  const u16 = (v: number) => (littleEndian ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (littleEndian ? u32le(v) : u32be(v));
  const tiff = bytes(
    littleEndian ? "II" : "MM",
    u16(42),
    u32(8),
    u16(3),
    u16(0x010f), u16(2), u32(6), u32(50), // Make -> offset 50
    u16(0x0112), u16(3), u32(1), u16(orientation), [0, 0],
    u16(0x8825), u16(4), u32(1), u32(56), // GPS IFD pointer
    u32(0),
    "Apple\0",
    "GPSGPS",
  );
  return bytes("Exif\0\0", tiff);
}

const SCAN = [0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44];

function jpeg(...segments: Uint8Array[]): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    segment(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
    ...segments,
    segment(0xdb, bytes([0], new Array<number>(64).fill(1))),
    segment(0xc0, bytes([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xc4, bytes([0], new Array<number>(16).fill(0))),
    segment(0xda, bytes([1, 1, 0, 0, 63, 0])),
    SCAN,
    [0xff, 0xd9],
  );
}

function markers(image: Uint8Array): number[] {
  const found: number[] = [];
  let at = 2;
  while (at < image.length) {
    const marker = image[at + 1] ?? 0;
    found.push(marker);
    if (marker === 0xda) break;
    at += 2 + Buffer.from(image).readUInt16BE(at + 2);
  }
  return found;
}

describe("cleanImage: JPEG", () => {
  it("passes a JPEG without metadata through unchanged", () => {
    const image = jpeg();
    expect(cleanImage(image)).toEqual({ type: "jpeg", bytes: image });
  });

  it("removes EXIF, XMP, comments and other application segments, keeping colour data", () => {
    const icc = segment(0xe2, "ICC_PROFILE\0\x01\x01profile");
    const adobe = segment(0xee, "Adobe\0\x64\0\0\0\0\x01");
    const image = jpeg(
      segment(0xe1, exif(1)),
      segment(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>"),
      icc,
      segment(0xed, "Photoshop 3.0\0secret"),
      adobe,
      segment(0xfe, "taken at home"),
    );
    const result = cleanImage(image);
    expect(result?.type).toBe("jpeg");
    const out = result?.bytes ?? new Uint8Array();
    expect(markers(out)).toEqual([0xe0, 0xe2, 0xee, 0xdb, 0xc0, 0xc4, 0xda]);
    const text = Buffer.from(out).toString("latin1");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("taken at home");
    expect(text).not.toContain("Apple");
    expect(Buffer.from(out.subarray(out.length - SCAN.length - 2))).toEqual(Buffer.from([...SCAN, 0xff, 0xd9]));
  });

  it("keeps a non-default orientation as an EXIF segment holding nothing else", () => {
    for (const littleEndian of [false, true]) {
      const out = cleanImage(jpeg(segment(0xe1, exif(6, littleEndian))))?.bytes ?? new Uint8Array();
      expect(markers(out)).toEqual([0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xda]);
      const app1 = Buffer.from(out.subarray(20 + 4, 20 + 4 + 32)); // after SOI and the 18-byte APP0
      expect(app1.toString("latin1")).toBe("Exif\0\0MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0");
      expect(Buffer.from(out).toString("latin1")).not.toContain("Apple");
    }
  });

  it("refuses a JPEG with no scan or a segment running past the end", () => {
    expect(cleanImage(bytes([0xff, 0xd8], segment(0xe0, "JFIF\0"), [0xff, 0xd9]))).toBeUndefined();
    expect(cleanImage(bytes([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2, 3]))).toBeUndefined();
    expect(cleanImage(bytes([0xff, 0xd8, 0xff]))).toBeUndefined();
  });
});

// --- WebP --------------------------------------------------------------------------------------

function riffChunk(fourcc: string, data: Uint8Array | string): Uint8Array {
  const body = typeof data === "string" ? Buffer.from(data, "latin1") : data;
  return bytes(fourcc, u32le(body.length), body, body.length % 2 ? [0] : []);
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const payload = bytes("WEBP", ...chunks);
  return bytes("RIFF", u32le(payload.length), payload);
}

const VP8 = riffChunk("VP8 ", bytes([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0]));
const ICC_FLAG = 0x20;
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;

function vp8x(flags: number): Uint8Array {
  return riffChunk("VP8X", bytes([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
}

describe("cleanImage: WebP", () => {
  it("passes a simple WebP through unchanged", () => {
    const image = webp(VP8);
    expect(cleanImage(image)).toEqual({ type: "webp", bytes: image });
  });

  it("removes EXIF, XMP and unknown chunks, clears their flags and fixes the RIFF size", () => {
    const iccp = riffChunk("ICCP", "profile");
    const image = webp(
      vp8x(ICC_FLAG | EXIF_FLAG | XMP_FLAG),
      iccp,
      VP8,
      riffChunk("EXIF", exif(6)),
      riffChunk("XMP ", "<x:xmpmeta>secret</x:xmpmeta>"),
      riffChunk("ZZZZ", "odd"),
    );
    const result = cleanImage(image);
    expect(result).toEqual({ type: "webp", bytes: webp(vp8x(ICC_FLAG), iccp, VP8) });
  });

  it("refuses a WebP whose RIFF size or chunk sizes do not add up", () => {
    const image = webp(VP8);
    expect(cleanImage(image.subarray(0, image.length - 2))).toBeUndefined();
    expect(cleanImage(webp(riffChunk("ICCP", "x")))).toBeUndefined(); // no image data at all
  });
});

describe("cleanImage: other content", () => {
  it("refuses GIF, SVG, text and empty input, whatever they claim to be", () => {
    expect(cleanImage(bytes("GIF89a\x01\0\x01\0"))).toBeUndefined();
    expect(cleanImage(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(cleanImage(bytes("hello.png"))).toBeUndefined();
    expect(cleanImage(new Uint8Array())).toBeUndefined();
  });
});
