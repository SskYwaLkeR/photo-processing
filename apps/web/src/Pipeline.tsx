import { useEffect, useState } from 'react';
import { ApiError, getStats } from './api';
import type { Stats } from './types';

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** Operator view: the scaling and backpressure part of the demo. Polls /api/admin/stats every second. */
export function Pipeline() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        setStats(await getStats());
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? `${err.status} ${err.message}` : 'API unreachable');
      }
      if (!stop) setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, []);

  if (!stats) return <main className="muted">{error ?? 'Loading…'}</main>;

  // The bottleneck is the stage whose oldest due task has waited longest (age, not depth).
  const worst = stats.stages.reduce((a, b) => (b.oldestQueuedMs > a.oldestQueuedMs ? b : a));
  const { admission } = stats;
  const pressure = Math.min(1, admission.inFlight / admission.globalMaxInFlight);

  return (
    <main>
      {error && <p className="error small">{error}</p>}
      <table className="stats">
        <thead>
          <tr>
            <th>stage</th>
            <th>queued</th>
            <th>retrying</th>
            <th>running</th>
            <th>oldest wait</th>
            <th>done/min</th>
            <th>p50</th>
            <th>p95</th>
            <th>failed (DLQ)</th>
            <th>replicas</th>
          </tr>
        </thead>
        <tbody>
          {stats.stages.map((s) => (
            <tr key={s.stage} className={s === worst && s.oldestQueuedMs > 2000 ? 'bottleneck' : ''}>
              <td>
                <b>{s.stage.toLowerCase()}</b>
              </td>
              <td>{s.queued}</td>
              <td>{s.retrying}</td>
              <td>
                {s.running}/{s.slots}
              </td>
              <td>{secs(s.oldestQueuedMs)}</td>
              <td>{s.doneLastMinute}</td>
              <td>{secs(s.p50Ms)}</td>
              <td>{secs(s.p95Ms)}</td>
              <td>{s.failed}</td>
              <td title={s.workers.map((w) => `${w.id} ${w.inFlight}/${w.concurrency}${w.draining ? ' draining' : ''}`).join('\n')}>
                {s.workers.map((w) => (
                  <span key={w.id} className={`dot ${w.draining ? 'draining' : w.inFlight > 0 ? 'busy' : ''}`} />
                ))}
                {s.replicas === 0 && <span className="error small">none</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="admission">
        <div>
          <b>Admission</b> · in flight {admission.inFlight} / {admission.globalMaxInFlight} · per-user cap {admission.userMaxInFlight} · 429s last
          minute <b>{admission.rejectedLastMinute}</b>{' '}
          {Object.entries(admission.rejectedByCode).map(([k, v]) => (
            <span key={k} className="tag">
              {k} {v}
            </span>
          ))}
        </div>
        <div className="bar">
          <div style={{ width: `${pressure * 100}%` }} className={pressure >= 1 ? 'full' : ''} />
        </div>
      </section>

      <p className="muted small">
        images: {Object.entries(stats.images).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(' · ') || 'none'} · updated{' '}
        {new Date(stats.at).toLocaleTimeString()}
      </p>
    </main>
  );
}
