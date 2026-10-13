import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, useList } from '../ui.tsx';

export function Connectors({ siteId }: { siteId: string }) {
  const list = useList<any>(`${M}/connectors?site_id=${siteId}`);
  const reviews = useList<any>(`${M}/review-items?site_id=${siteId}`);
  const [compat, setCompat] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [name, setName] = useState('Labeled simulator');
  const [serviceAccountId, setServiceAccountId] = useState('');
  const [reason, setReason] = useState('Activated for local demo only');

  const loadCompat = async () => {
    setErr(null);
    try {
      const r = await api<{ items: any[] }>(`${M}/connectors/compatibility`);
      setCompat(r.items);
    } catch (e) {
      setErr(e);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/connectors`, {
        method: 'POST',
        body: JSON.stringify({
          site_id: siteId,
          provider: 'simulated',
          name,
          provider_instance: 'local-demo',
          secret_ref: null,
          service_account_id: serviceAccountId,
        }),
      });
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const open = async (id: string) => {
    setErr(null);
    try {
      const [c, health] = await Promise.all([
        api<Record<string, unknown>>(`${M}/connectors/${id}`),
        api(`${M}/connectors/${id}/health`).catch(() => null),
      ]);
      setSelected({ ...c, health });
    } catch (e) {
      setErr(e);
    }
  };

  const setStatus = async (action: 'activate' | 'pause' | 'disable') => {
    if (!selected) return;
    setErr(null);
    try {
      await api(`${M}/connectors/${selected.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ record_version: selected.version, reason }),
      });
      await open(selected.id);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <h2>Connectors</h2>
      <p className="muted">
        Live and OpenRemote adapters are not qualified and refuse to connect. Only the labeled simulated connector can produce events,
        and only when <code>ALLOW_SIMULATED_CONNECTORS=true</code>. Core work continues if connectors are disabled.
      </p>
      <button type="button" className="secondary" onClick={() => void loadCompat()}>Show compatibility matrix</button>
      {compat && (
        <table>
          <thead><tr><th>Provider</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>
            {compat.map((c) => (
              <tr key={c.provider}><td>{c.provider}</td><td><Badge state={c.status} /></td><td>{(c.limitations ?? []).join(' ') || '—'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="card" onSubmit={(e) => void create(e)}>
        <h3>Create labeled simulator</h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Connector service account id<input value={serviceAccountId} onChange={(e) => setServiceAccountId(e.target.value)} required placeholder="uuid" /></label>
        <button type="submit">Create</button>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={list.err} />
      <table>
        <thead><tr><th>Name</th><th>Provider</th><th>Status</th><th>Simulated</th><th></th></tr></thead>
        <tbody>
          {list.items.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.provider}</td>
              <td><Badge state={c.status} /></td>
              <td>{c.simulated ? 'yes' : 'no'}</td>
              <td><button type="button" className="secondary" onClick={() => void open(c.id)}>Open</button></td>
            </tr>
          ))}
          {!list.items.length && emptyRow(5, list.loading, 'No connectors configured.')}
        </tbody>
      </table>
      <h3>Review queue</h3>
      <ErrorBox err={reviews.err} />
      <ul>
        {reviews.items.map((r) => (
          <li key={r.id} className="card">
            <Badge state={r.status} /> {r.kind ?? r.reason} · {r.created_at}
          </li>
        ))}
        {!reviews.items.length && !reviews.loading && <li className="muted">No open review items.</li>}
      </ul>
      {selected && (
        <Panel title={selected.name} onClose={() => setSelected(null)}>
          <p><Badge state={selected.status} /> {selected.provider} · simulated={String(selected.simulated)}</p>
          {selected.health && <pre className="muted">{JSON.stringify(selected.health, null, 2)}</pre>}
          <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="row">
            <button type="button" onClick={() => void setStatus('activate')}>Activate</button>
            <button type="button" className="secondary" onClick={() => void setStatus('pause')}>Pause</button>
            <button type="button" className="secondary" onClick={() => void setStatus('disable')}>Disable</button>
          </div>
          <ErrorBox err={err} />
        </Panel>
      )}
    </>
  );
}
