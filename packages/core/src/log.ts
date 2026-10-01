/**
 * Structured logs: one JSON object per line, so `| grep imageId` and log pipelines both work.
 * Plain console.log on purpose (no logging framework).
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
