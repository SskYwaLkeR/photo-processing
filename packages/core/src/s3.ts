import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

let client: S3Client | undefined;

function s3(): S3Client {
  if (!config.s3.bucket || !config.s3.region) throw new Error('S3_BUCKET and AWS_REGION must be set');
  client ??= new S3Client({ region: config.s3.region, maxAttempts: 3 });
  return client;
}

const Bucket = () => config.s3.bucket;

/** 404 needs s3:ListBucket on the prefix; without it S3 answers 403 for a missing key. */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export const storage = {
  /** Browser-direct upload. The POST policy pins the key and makes S3 itself refuse oversized bodies. */
  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const { url, fields } = await createPresignedPost(s3(), {
      Bucket: Bucket(),
      Key: key,
      Conditions: [
        ['content-length-range', 1, config.limits.maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: config.s3.presignUploadTtlSeconds,
    });
    return { url, fields };
  },

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const res = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key }));
      return { sizeBytes: res.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** First bytes only, for the magic-byte check at /complete. */
  async getRange(key: string, bytes: number): Promise<Uint8Array> {
    const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key, Range: `bytes=0-${bytes - 1}` }));
    return res.Body ? res.Body.transformToByteArray() : new Uint8Array();
  },

  async getBuffer(key: string): Promise<Buffer> {
    const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
    if ((res.ContentLength ?? 0) > config.limits.maxBytes) throw new Error(`Object ${key} exceeds max bytes`);
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  },

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: body, ContentType: contentType }));
  },

  /** Server-side copy: no bytes through the worker. */
  async copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
    await s3().send(
      new CopyObjectCommand({
        Bucket: Bucket(),
        CopySource: `${Bucket()}/${fromKey}`,
        Key: toKey,
        ContentType: contentType,
        MetadataDirective: 'REPLACE',
      }),
    );
  },

  /**
   * Short-lived read URL. The response headers are forced, so even a malicious object could never be
   * rendered as HTML. Signed against a time bucket: the URL (and the API response ETag) only changes
   * every readUrlBucketSeconds, which lets polling clients get 304s.
   */
  presignGet(key: string): Promise<string> {
    const bucketMs = config.s3.readUrlBucketSeconds * 1000;
    const signingDate = new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
    return getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: Bucket(),
        Key: key,
        ResponseContentType: 'image/jpeg',
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: config.s3.readUrlTtlSeconds, signingDate },
    );
  },

  /** Keys under a prefix (first page is plenty for per-image prefixes). */
  async list(prefix: string): Promise<string[]> {
    const res = await s3().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: prefix, MaxKeys: 100 }));
    return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
  },

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await s3().send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
  },
};
