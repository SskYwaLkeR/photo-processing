export type DetectedFormat = 'jpeg' | 'png' | 'heic';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// ISO-BMFF major brands used by HEIC/HEIF stills (iPhone writes "heic"; some Android "mif1").
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** The real format comes from magic bytes. The browser-declared MIME type is never trusted. */
export function sniffFormat(buf: Uint8Array): DetectedFormat | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (b.toString('ascii', 4, 8) === 'ftyp' && HEIC_BRANDS.has(b.toString('ascii', 8, 12))) return 'heic';
  return null;
}

export const SNIFF_BYTES = 32;
