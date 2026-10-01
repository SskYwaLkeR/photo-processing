declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer>;
}
