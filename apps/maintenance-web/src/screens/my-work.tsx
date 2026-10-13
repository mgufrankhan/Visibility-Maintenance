import { useState } from 'react';
import { M, api } from '../api.ts';
import { enqueue } from '../offline.ts';
import { Badge, ErrorBox, emptyRow, useList } from '../ui.tsx';

export function MyWork({ siteId, online, onQueued }: { siteId: string; online: boolean; onQueued: () => Promise<void> }) {
  const list = useList<any>(`${M}/my-work?site_id=${siteId}`);
  const [msg, setMsg] = useState('');
  const [qr, setQr] = useState('');
  const [resolved, setResolved] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);

  const start = async (wo: any) => {
    setErr(null);
    const op = { client_op_id: crypto.randomUUID(), type: 'transition' as const, record_id: wo.id as string, base_version: wo.version as number, payload: { action: 'start' } };
    if (!online) {
      await enqueue(op);
      setMsg(`Saved locally. Start of WO-${wo.display_number} will sync when you are back online. Approvals are not available offline.`);
      await onQueued();
      return;
    }
    await api(`${M}/work-orders/${wo.id}/transitions`, { method: 'POST', body: JSON.stringify({ action: 'start', record_version: wo.version }) });
    setMsg(`Started WO-${wo.display_number}`);
    list.reload();
  };

  const resolveQr = async () => {
    setErr(null);
    try {
      const asset = await api<any>(`${M}/qr/${encodeURIComponent(qr.trim())}`);
      setResolved(asset);
      setMsg(`Resolved ${asset.code} — ${asset.name}. Open Work Orders or submit a request for this asset.`);
    } catch (e) {
      setErr(e);
      setResolved(null);
    }
  };

  return (
    <>
      <h2>My Work</h2>
      <p className="muted">{online ? 'Assigned and team-queue work.' : 'Showing last cached list. Approvals and cross-team assignment are not available offline.'}</p>
      <div className="card">
        <h3>Scan QR</h3>
        <p className="muted">Paste an authenticated QR token. Resolution always runs as your signed-in identity.</p>
        <div className="row">
          <label>QR token<input value={qr} onChange={(e) => setQr(e.target.value)} placeholder="token from asset tag" /></label>
          <button type="button" onClick={() => void resolveQr()}>Resolve</button>
        </div>
        {resolved && (
          <p>
            Asset <strong>{resolved.code}</strong> {resolved.name} at site {resolved.site_id} ({resolved.lifecycle}).
            Identity source: {resolved.identity_source}.
            <a href={`#/requests`}> Report fault</a> · <a href={`#/assets`}> Open assets</a>
          </p>
        )}
      </div>
      {msg && <p role="status">{msg}</p>}
      <ErrorBox err={list.err ?? err} />
      <ul>
        {list.items.map((w) => (
          <li key={w.id} className="card">
            <strong>WO-{w.display_number}</strong> {w.title} <Badge state={w.state} />
            {w.overdue && <span className="badge warn">overdue</span>}
            <p className="muted">{w.procedure_snapshot ? `Procedure ${w.procedure_snapshot.title} rev ${w.procedure_snapshot.revision_no}` : 'No issued procedure'}</p>
            <div className="row">
              <button type="button" onClick={() => void start(w).catch((e) => setErr(e))}>Start</button>
              <a href={`#/work`}>Open detail list</a>
            </div>
          </li>
        ))}
        {!list.items.length && !list.loading && <li className="muted">No assigned work in this site.</li>}
        {list.loading && emptyRow(1, true)}
      </ul>
    </>
  );
}
