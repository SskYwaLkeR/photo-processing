import type { Image, Stats } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.message ?? `Request failed (${res.status})`, res.status, body?.error?.code ?? 'HTTP_ERROR');
  return body as T;
}

const post = <T>(path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

export const listImages = (ids?: string[]) => call<{ items: Image[] }>(ids ? `/images?ids=${ids.join(',')}` : '/images?limit=100');
export const getImage = (id: string) => call<{ image: Image }>(`/images/${id}`);
export const reprocess = (id: string, force = false) => post<{ image: Image }>(`/images/${id}/reprocess${force ? '?force=true' : ''}`);
export const getStats = () => call<Stats>('/admin/stats');

/** create (idempotent) → presigned POST straight to S3 → complete. The API never sees the bytes. */
export async function uploadFile(file: File): Promise<Image> {
  const { image, upload } = await post<{ image: Image; upload: { url: string; fields: Record<string, string> } | null }>(
    '/images',
    { filename: file.name, mimeType: file.type, sizeBytes: file.size },
    { 'idempotency-key': crypto.randomUUID() },
  );
  if (upload) {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file); // S3 requires the file to be the last field
    const res = await fetch(upload.url, { method: 'POST', body: form });
    if (!res.ok) throw new ApiError(`Upload to storage failed (${res.status})`, res.status, 'STORAGE_ERROR');
  }
  try {
    return (await post<{ image: Image }>(`/images/${image.id}/complete`)).image;
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) return (await getImage(image.id)).image; // REJECTED: show it with its reason
    throw err;
  }
}
