import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getImage, listImages, reprocess, uploadFile } from './api';
import { TERMINAL, type Image, type Stage } from './types';

const STAGES: { stage: Stage; label: string }[] = [
  { stage: 'CONVERT', label: 'Convert' },
  { stage: 'COMPRESS', label: 'Compress' },
  { stage: 'VARIANTS', label: 'Variants' },
];
const UPLOAD_CONCURRENCY = 3;

const kb = (n: number | null | undefined) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

type StepState = 'done' | 'running' | 'queued' | 'failed' | 'pending';

function steps(img: Image): StepState[] {
  const idx = (s: Stage | null) => STAGES.findIndex((x) => x.stage === s);
  if (img.status === 'COMPLETE') return ['done', 'done', 'done'];
  if (img.status === 'FAILED') {
    const f = idx(img.error?.stage ?? img.stage);
    return STAGES.map((_, i) => (i < f ? 'done' : i === f ? 'failed' : 'pending'));
  }
  if (img.status === 'PROCESSING') {
    const c = idx(img.stage);
    const running = /ING/.test(img.state);
    return STAGES.map((_, i) => (i < c ? 'done' : i === c ? (running ? 'running' : 'queued') : 'pending'));
  }
  return ['pending', 'pending', 'pending'];
}

export function MyImages() {
  const [images, setImages] = useState<Map<string, Image>>(new Map());
  const [uploading, setUploading] = useState<{ name: string; error?: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const queue = useRef<File[]>([]);
  const active = useRef(0);

  const merge = useCallback((items: Image[]) => {
    setImages((prev) => {
      const next = new Map(prev);
      for (const i of items) next.set(i.id, i);
      return next;
    });
  }, []);

  useEffect(() => {
    listImages().then((r) => merge(r.items)).catch(() => {});
  }, [merge]);

  // Poll only in-flight images, 100 ids per request; ETags make unchanged responses 304s.
  useEffect(() => {
    const inFlight = [...images.values()].filter((i) => !TERMINAL.has(i.status)).map((i) => i.id);
    if (inFlight.length === 0) return;
    const t = setTimeout(async () => {
      for (let k = 0; k < inFlight.length; k += 100) {
        const r = await listImages(inFlight.slice(k, k + 100)).catch(() => null);
        if (r) merge(r.items);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [images, merge]);

  const pump = useCallback(() => {
    while (active.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const file = queue.current.shift()!;
      active.current++;
      uploadFile(file)
        .then((img) => {
          merge([img]);
          setUploading((u) => u.filter((x) => x.name !== file.name));
        })
        .catch((err: Error) => setUploading((u) => u.map((x) => (x.name === file.name ? { ...x, error: err.message } : x))))
        .finally(() => {
          active.current--;
          pump();
        });
    }
  }, [merge]);

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    queue.current.push(...files);
    setUploading((u) => [...u, ...[...files].map((f) => ({ name: f.name }))]);
    pump();
  };

  const sorted = [...images.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <main>
      <label
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input type="file" multiple accept="image/jpeg,image/png,image/heic,image/heif,.heic" onChange={(e) => addFiles(e.target.files)} />
        <strong>Drop images here</strong> or click to choose · JPEG, PNG, HEIC
      </label>

      {uploading.map((u) => (
        <div key={u.name} className={`uploading ${u.error ? 'error' : ''}`}>
          {u.error ? `✕ ${u.name}: ${u.error}` : `↑ Uploading ${u.name}…`}
        </div>
      ))}

      <ul className="images">
        {sorted.map((img) => (
          <ImageRow key={img.id} image={img} onChange={(i) => merge([i])} />
        ))}
      </ul>
      {sorted.length === 0 && uploading.length === 0 && <p className="muted">No images yet.</p>}
    </main>
  );
}

const ImageRow = memo(function ImageRow({ image, onChange }: { image: Image; onChange: (i: Image) => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Image | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The expanded view loads the full record (timeline included) and refreshes while it changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getImage(image.id).then((r) => !cancelled && setDetail(r.image)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, image.id, image.state, image.run]);

  const doReprocess = async (force: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      onChange((await reprocess(image.id, force)).image);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Reprocess failed');
    } finally {
      setBusy(false);
    }
  };

  const view = detail && detail.run === image.run ? { ...detail, ...image, timeline: detail.timeline } : image;
  const thumb = view.variants.find((v) => v.name === 'thumb');

  return (
    <li className={`row ${view.status.toLowerCase()}`}>
      <div className="summary" onClick={() => setOpen((o) => !o)}>
        <div className="thumb">{thumb ? <img src={thumb.url} alt="" loading="lazy" /> : <span>{view.original.format ?? '…'}</span>}</div>
        <div className="info">
          <div className="name" title={view.filename}>
            {view.filename}
            {view.run > 1 && <span className="tag">run {view.run}</span>}
          </div>
          <div className="stepper">
            {STAGES.map((s, i) => (
              <span key={s.stage} className={`step ${steps(view)[i]}`}>
                {s.label}
              </span>
            ))}
            <span className={`state ${view.status.toLowerCase()}`}>
              {view.state.replace(/_/g, ' ').toLowerCase()}
              {view.attempt && view.attempt > 1 ? ` · attempt ${view.attempt}` : ''}
            </span>
          </div>
          {view.compression && (
            <div className="muted small">
              {kb(view.compression.originalBytes)} → {kb(view.compression.compressedBytes)} (
              {view.compression.savedPercent >= 0
                ? `${view.compression.savedPercent}% smaller`
                : `${-view.compression.savedPercent}% larger: ${view.original.format === 'heic' ? 'HEIC is more efficient than JPEG' : 'source was already compact'}`}
              , q{view.compression.quality})
            </div>
          )}
          {view.error && (
            <div className="error small">
              <b>{view.error.stage?.toLowerCase() ?? 'validation'}</b> · {view.error.code} · {view.error.message}
            </div>
          )}
          {actionError && <div className="error small">{actionError}</div>}
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {view.canReprocess && (
            <button disabled={busy} onClick={() => doReprocess(false)}>
              Reprocess
            </button>
          )}
          {view.status === 'COMPLETE' && (
            <button className="ghost" disabled={busy} onClick={() => doReprocess(true)} title="Force a full re-run (idempotent: still exactly 3 variants)">
              Regenerate
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="detail">
          {view.variants.length > 0 && (
            <div className="variants">
              {view.variants.map((v) => (
                <a key={v.name} href={v.url} target="_blank" rel="noreferrer" className={v.current ? '' : 'stale'}>
                  <img src={v.url} alt={v.name} loading="lazy" />
                  <span>
                    <b>{v.name}</b> {v.width}×{v.height} · {kb(v.bytes)}
                    {!v.current && ` · run ${v.run} (previous)`}
                  </span>
                </a>
              ))}
            </div>
          )}
          <ol className="timeline">
            {(view.timeline ?? []).map((e, i) => (
              <li key={i}>
                <time>{new Date(e.at).toLocaleTimeString()}</time> <span className="tag">run {e.run}</span> {e.stage?.toLowerCase() ?? ''}{' '}
                <b>{e.type.toLowerCase().replace(/_/g, ' ')}</b> {e.detail && <span className="muted">{e.detail}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
});
