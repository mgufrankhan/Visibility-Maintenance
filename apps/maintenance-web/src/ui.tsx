import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, M, api, loadSession } from './api.ts';

export function statusBadge(state: string) {
  if (['closed', 'approved', 'available', 'active', 'ready'].includes(state)) return 'ok';
  if (['rejected', 'cancelled', 'failed', 'expired', 'disabled', 'quarantined'].includes(state)) return 'bad';
  if (['overdue', 'pending', 'pending_review', 'on_hold', 'submitted', 'under_review', 'draft', 'paused'].includes(state)) return 'warn';
  return '';
}

export function ErrorBox({ err }: { err: unknown }) {
  if (!err) return null;
  if (err instanceof ApiError) {
    const fields = err.field_errors
      ? Object.entries(err.field_errors).map(([k, v]) => `${k}: ${v.join('; ')}`).join(' · ')
      : '';
    return (
      <p className="err" role="alert">
        {err.message}{fields ? ` — ${fields}` : ''}{err.correlation_id ? ` (${err.correlation_id})` : ''}
      </p>
    );
  }
  return <p className="err" role="alert">{String(err)}</p>;
}

export function Badge({ state }: { state: string }) {
  return <span className={`badge ${statusBadge(state)}`}>{state}</span>;
}

export function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return (
    <div className="card panel" role="dialog" aria-label={title}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {onClose && <button type="button" className="secondary" onClick={onClose}>Close</button>}
      </div>
      {children}
    </div>
  );
}

export function useList<T>(path: string | null) {
  const [items, setItems] = useState<T[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<{ items: T[] }>(path)
      .then((r) => { if (!cancelled) { setItems(r.items ?? []); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, tick]);
  return { items, err, loading, setItems, reload: () => setTick((t) => t + 1) };
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadEvidence(ownerType: string, ownerId: string, file: File, stepKey?: string | null) {
  const buf = await file.arrayBuffer();
  const sha = await sha256Hex(buf);
  const slot = await api<{ id: string; upload_url: string }>(`${M}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: file.name,
      media_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      sha256: sha,
      step_key: stepKey ?? null,
    }),
  });
  const session = loadSession();
  const put = await fetch(slot.upload_url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(session ? { authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: buf,
  });
  if (!put.ok) {
    const body = await put.json().catch(() => ({}));
    throw new ApiError(put.status, body?.error?.code ?? 'upload_failed', body?.error?.message ?? 'Upload failed');
  }
  return slot.id;
}

export function isoLocal(d = new Date()): string {
  return d.toISOString();
}

export function emptyRow(colSpan: number, loading: boolean, label = 'No records.') {
  if (loading) return <tr><td colSpan={colSpan} className="muted">Loading…</td></tr>;
  return <tr><td colSpan={colSpan} className="muted">{label}</td></tr>;
}
