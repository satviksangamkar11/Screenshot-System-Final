/**
 * Minimal PNG dimension reader.
 *
 * Screenshots must be scaled to a fixed document width while preserving aspect
 * ratio, which requires their natural size. A PNG's IHDR chunk carries that in
 * the first 24 bytes, so no image library is needed.
 */

export interface PngSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads a PNG's pixel dimensions, or null when the buffer is not a PNG. */
export function readPngSize(buffer: Buffer): PngSize | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // Bytes 16-23 are the IHDR width and height, big-endian.
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}
