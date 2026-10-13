import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, M, api, loadSession } from './api.ts';

export function statusBadge(state: string) {
  if (['closed', 'approved', 'available', 'active', 'ready'].includes(state)) return 'ok';
  if (['rejected', 'cancelled', 'failed', 'expired', 'disabled', 'quarantined'].includes(state)) return 'bad';
  if (['overdue', 'pending', 'pending_review', 'on_hold', 'submitted', 'under_review', 'draft', 'paused'].includes(state)) return 'warn';
  return '';
}

/** Humanize snake_case / kebab status labels for display. */
export function prettyLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ');
}

/** Product mark — full lockup on login, compact mark in the shell nav. */
export function BrandLogo({ variant = 'full' }: { variant?: 'full' | 'nav' }) {
  if (variant === 'nav') {
    return (
      <a className="brand brand-nav" href="#/overview" aria-label="Visibility Maintenance">
        <img src="/logo.jpg" alt="" width={180} height={72} decoding="async" />
      </a>
    );
  }
  return (
    <div className="brand brand-hero">
      <img src="/logo.jpg" alt="Visibility Maintenance" width={320} height={128} decoding="async" />
    </div>
  );
}

export function ErrorBox({ err }: { err: unknown }) {
  if (!err) return null;
  if (err instanceof ApiError) {
    const fields = err.field_errors
      ? Object.entries(err.field_errors).map(([k, v]) => `${k}: ${v.join('; ')}`).join(' · ')
      : '';
    return (
      <div className="alert alert-error" role="alert">
        <div>
          <strong>{err.message}</strong>
          {fields ? <div>{fields}</div> : null}
          {err.correlation_id ? <div className="muted" style={{ color: 'inherit', opacity: 0.85 }}>Ref {err.correlation_id}</div> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert-error" role="alert">
      <div>{String(err)}</div>
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div className={`alert alert-${tone}`} role="status">
      <div>{children}</div>
    </div>
  );
}

export function Badge({ state }: { state: string }) {
  return <span className={`badge ${statusBadge(state)}`}>{prettyLabel(state)}</span>;
}

export function ConnectionStatus({ online }: { online: boolean }) {
  return (
    <span className="status-pill">
      <span className={`status-dot ${online ? 'online' : 'offline'}`} aria-hidden="true" />
      {online ? 'Online' : 'Offline — cached work only'}
    </span>
  );
}

export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h2>{title}</h2>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {detail ? <p className="muted">{detail}</p> : null}
    </div>
  );
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
  if (loading) {
    return (
      <tr>
        <td colSpan={colSpan}>
          <div className="skeleton" style={{ width: '40%', margin: '0.35rem 0' }} />
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={colSpan}>
        <EmptyState title={label} />
      </td>
    </tr>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <div className="table-wrap"><table>{children}</table></div>;
}
