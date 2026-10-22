import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Notice, PageHeader, Table, emptyRow, useList } from '../ui.tsx';

export function Overview({ siteId }: { siteId: string }) {
  const work = useList<any>(`${M}/work-orders?site_id=${siteId}&limit=50`);
  const reqs = useList<any>(`${M}/requests?site_id=${siteId}&limit=50`);
  const plans = useList<any>(`${M}/plans?site_id=${siteId}&status=active`);
  const overdue = work.items.filter((w) => w.overdue);
  const openReqs = reqs.items.filter((r) => r.state === 'submitted' || r.state === 'under_review');
  const ready = work.items.filter((w) => w.state === 'ready');
  const recentWork = work.items.slice(0, 5);
  const recentReqs = openReqs.slice(0, 5);
  return (
    <>
      <PageHeader
        title="Overview"
        lede="Site workload at a glance. Report faults and run calendar PM without Live, OpenRemote, or Neo."
        actions={
          <>
            <a className="secondary" style={{ padding: '0.5rem 0.9rem', borderRadius: 7, textDecoration: 'none', fontWeight: 600 }} href="#/requests">Report fault</a>
            <a className="secondary" style={{ padding: '0.5rem 0.9rem', borderRadius: 7, textDecoration: 'none', fontWeight: 600 }} href="#/my-work">My Work</a>
          </>
        }
      />
      <div className="stat-grid">
        <a className={`stat-card ${overdue.length ? 'warn' : ''}`} href="#/work">
          <span className="stat-value">{work.loading ? '…' : overdue.length}</span>
          <div className="stat-label">Overdue work</div>
        </a>
        <a className="stat-card" href="#/requests">
          <span className="stat-value">{reqs.loading ? '…' : openReqs.length}</span>
          <div className="stat-label">Open requests</div>
        </a>
        <a className={`stat-card ${ready.length ? 'ok' : ''}`} href="#/work">
          <span className="stat-value">{work.loading ? '…' : ready.length}</span>
          <div className="stat-label">Ready orders</div>
        </a>
        <a className="stat-card" href="#/pm">
          <span className="stat-value">{plans.loading ? '…' : plans.items.length}</span>
          <div className="stat-label">Active PM plans</div>
        </a>
      </div>
      <ErrorBox err={work.err ?? reqs.err ?? plans.err} />
      <div className="split-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Open requests</h3>
          {recentReqs.length === 0 && !reqs.loading && <p className="muted">No open requests.</p>}
          <ul className="list-recent">
            {recentReqs.map((r) => (
              <li key={r.id}>
                <a className="title" href="#/requests">#{r.display_number} · {r.description}</a>
                <Badge state={r.state} />
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Recent work orders</h3>
          {recentWork.length === 0 && !work.loading && <p className="muted">No work orders yet.</p>}
          <ul className="list-recent">
            {recentWork.map((w) => (
              <li key={w.id}>
                <a className="title" href="#/work">WO-{w.display_number} · {w.title}</a>
                <span className="row" style={{ gap: '0.35rem' }}>
                  {w.overdue && <span className="badge warn">overdue</span>}
                  <Badge state={w.state} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Notice tone="info">
        Connectors and Neo are optional. Manual fault reporting, planning, and completion stay available when telemetry or AI are offline.
      </Notice>
    </>
  );
}

export function Downtime({ siteId }: { siteId: string }) {
  const list = useList<any>(`${M}/downtime-events?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}&limit=100`);
  const [assetId, setAssetId] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/downtime-events`, {
        method: 'POST',
        body: JSON.stringify({
          asset_id: assetId,
          classification: 'candidate',
          started_at: new Date().toISOString(),
        }),
      });
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <PageHeader title="Downtime" lede="Record candidate downtime against maintainable assets. Labor time and equipment downtime stay separate." />
      <form className="card" onSubmit={(e) => void create(e)}>
        <div className="row">
          <label>Asset
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
              <option value="">Select asset…</option>
              {assets.items.map((a) => <option key={a.asset?.id} value={a.asset?.id}>{a.asset?.code} — {a.asset?.name}</option>)}
            </select>
          </label>
          <button type="submit">Open candidate downtime</button>
        </div>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={list.err} />
      <Table>
        <thead><tr><th>Asset</th><th>Classification</th><th>Started</th><th>Restored</th></tr></thead>
        <tbody>
          {list.items.map((d) => (
            <tr key={d.id}><td><code>{d.asset_id}</code></td><td><Badge state={d.classification} /></td><td>{d.started_at}</td><td>{d.restored_at ?? 'open'}</td></tr>
          ))}
          {!list.items.length && emptyRow(4, list.loading)}
        </tbody>
      </Table>
    </>
  );
}

export function Reports({ siteId }: { siteId: string }) {
  const [metric, setMetric] = useState('failure_count');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = async () => {
    setErr(null);
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400000);
    try {
      setData(await api(`${M}/reports/${metric}?site_id=${siteId}&from=${from.toISOString()}&to=${to.toISOString()}`));
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <PageHeader
        title="Reports"
        lede="Reliability metrics for the last 90 days at this site."
        actions={
          <a
            className="secondary"
            style={{ padding: '0.5rem 0.9rem', borderRadius: 7, background: 'var(--brand-soft)', textDecoration: 'none', fontWeight: 600, color: 'var(--brand)' }}
            href={`${M}/exports/work_orders.csv?site_id=${siteId}&from=${new Date(Date.now() - 90 * 86400000).toISOString()}&to=${new Date().toISOString()}`}
          >
            Export work orders CSV
          </a>
        }
      />
      <div className="card">
        <div className="row">
          <label>Metric
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {['failure_count', 'mtbf', 'mttr', 'mtta', 'downtime', 'overdue_backlog', 'pm_compliance', 'repeat_faults', 'maintenance_cost'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void run()}>Run report</button>
        </div>
      </div>
      <ErrorBox err={err} />
      {data && (
        <div className="card">
          {data.coverage_notes && <p className="muted">{Array.isArray(data.coverage_notes) ? data.coverage_notes.join(' ') : String(data.coverage_notes)}</p>}
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </div>
      )}
    </>
  );
}

export function Neo({ siteId }: { siteId: string }) {
  const recs = useList<any>(`${M}/recommendations?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}`);
  const [query, setQuery] = useState('');
  const [assetId, setAssetId] = useState('');
  const [draftKind, setDraftKind] = useState<'none' | 'draft_request' | 'draft_work_order' | 'propose_checklist'>('none');
  const [answer, setAnswer] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      setAnswer(await api(`${M}/neo/ask`, {
        method: 'POST',
        body: JSON.stringify({
          site_id: siteId,
          asset_id: assetId || null,
          query,
          draft_request: draftKind === 'draft_request',
          draft_work_order: draftKind === 'draft_work_order',
          propose_checklist: draftKind === 'propose_checklist',
        }),
      }));
      recs.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const decide = async (id: string, actionVersion: number, decision: 'approve' | 'reject') => {
    setErr(null);
    try {
      await api(`${M}/recommendations/${id}/decisions`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: `${decision} recommendation from web`, action_version: actionVersion }),
      });
      recs.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <PageHeader
        title="Neo"
        lede="Optional assistant. Answers are retrieval-only until a qualified model exists. The proposer cannot approve their own draft."
      />
      <form className="card" onSubmit={(e) => void ask(e)}>
        <label>Asset
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">—</option>
            {assets.items.map((a) => <option key={a.asset?.id} value={a.asset?.id}>{a.asset?.code}</option>)}
          </select>
        </label>
        <label>Question<textarea value={query} onChange={(e) => setQuery(e.target.value)} required /></label>
        <label>Review-only draft
          <select value={draftKind} onChange={(e) => setDraftKind(e.target.value as typeof draftKind)}>
            <option value="none">Answer only</option>
            <option value="draft_request">Draft request</option>
            <option value="draft_work_order">Draft work order</option>
            <option value="propose_checklist">Propose checklist (never publishes)</option>
          </select>
        </label>
        <button type="submit">Ask</button>
        <ErrorBox err={err} />
      </form>
      {answer && (
        <div className="card">
          <p><strong>Observations.</strong> {answer.observations}</p>
          <p><strong>Possible causes.</strong> {(answer.possible_causes ?? []).join(' ') || '—'}</p>
          <p><strong>Checks.</strong> {(answer.recommended_checks ?? []).join(' ')}</p>
          <p className="muted">Runtime {answer.runtime}; model {answer.model_version ?? 'none'}; policy {answer.inference_policy}.</p>
          <ul>{(answer.citations ?? []).map((c: any) => (
            <li key={`${c.kind}-${c.id}`}>{c.kind} {c.title}{c.freshness ? ` · ${c.freshness}` : ''}{c.untrusted ? ' (untrusted document)' : ''}</li>
          ))}</ul>
          {(answer.missing_evidence ?? []).length > 0 && <p className="muted">Missing: {answer.missing_evidence.join(' ')}</p>}
        </div>
      )}
      <h3>Recommendations</h3>
      {recs.items.map((r) => (
        <div key={r.id} className="card">
          <Badge state={r.status} /> {r.action_type} v{r.action_version}
          <pre className="muted">{JSON.stringify(r.action_payload, null, 2)}</pre>
          {r.status === 'pending' && (
            <div className="row">
              <button type="button" onClick={() => void decide(r.id, r.action_version, 'approve')}>Approve exact action</button>
              <button type="button" className="secondary" onClick={() => void decide(r.id, r.action_version, 'reject')}>Reject</button>
            </div>
          )}
        </div>
      ))}
      {!recs.items.length && !recs.loading && <p className="muted">No recommendations.</p>}
    </>
  );
}
