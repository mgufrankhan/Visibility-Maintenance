import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, useList, PageHeader, Table } from '../ui.tsx'

const PLAN_STATUSES = ['draft', 'active', 'paused', 'archived'];

function planFilter(siteId: string, query: string): { path: string; note: string | null } {
  const status = new URLSearchParams(query).get('status');
  const search = new URLSearchParams({ site_id: siteId });
  if (!status || !PLAN_STATUSES.includes(status)) return { path: `${M}/plans?${search.toString()}`, note: null };
  search.set('status', status);
  return { path: `${M}/plans?${search.toString()}`, note: status === 'active' ? 'Active plans only' : `Status ${status}` };
}

export function Plans({ siteId, query }: { siteId: string; query: string }) {
  const filter = planFilter(siteId, query);
  const list = useList<any>(filter.path);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}`);
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const procedures = useList<any>(`${M}/procedures?site_id=${siteId}`);
  const parts = useList<any>(`${M}/parts`);
  const [selected, setSelected] = useState<any>(null);
  const [preview, setPreview] = useState<Array<{ key: string; due_at: string }>>([]);
  const [err, setErr] = useState<unknown>(null);
  const [title, setTitle] = useState('');
  const [assetId, setAssetId] = useState('');
  const [procRev, setProcRev] = useState('');
  const [teamId, setTeamId] = useState('');
  const [interval, setInterval] = useState('1');
  const [unit, setUnit] = useState<'week' | 'day' | 'month'>('week');
  const [anchor, setAnchor] = useState('2026-10-13');
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [reason, setReason] = useState('Paused from web planner');
  const [partId, setPartId] = useState('');
  const [partQty, setPartQty] = useState('1');
  const [kind, setKind] = useState<'calendar' | 'completion'>('calendar');

  const open = async (id: string) => {
    setErr(null);
    try {
      setSelected(await api(`${M}/plans/${id}`));
      setPreview([]);
    } catch (e) {
      setErr(e);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const plan = await api<any>(`${M}/plans`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, asset_id: assetId, title, trigger_kind: kind }),
      });
      const rev = await api<any>(`${M}/plans/${plan.id}/revisions`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          scope: `Scheduled ${title}`,
          procedure_revision_id: procRev,
          team_id: teamId,
          estimated_minutes: 30,
          lead_days: 7,
          trigger: { type: kind, unit, interval: Number(interval), anchor_date: anchor, time_of_day: timeOfDay },
          effective_from: anchor,
          expected_parts: partId ? [{ part_id: partId, quantity: Number(partQty) }] : [],
        }),
      });
      setSelected(await api(`${M}/plans/${plan.id}`));
      setProcRev(rev.id);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const publish = async (revisionId: string) => {
    setErr(null);
    try {
      await api(`${M}/plan-revisions/${revisionId}/publish`, { method: 'POST', body: '{}' });
      await open(selected.id);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const runPreview = async (revisionId: string) => {
    setErr(null);
    try {
      const r = await api<{ items: Array<{ key: string; due_at: string }> }>(`${M}/plan-revisions/${revisionId}/preview?count=6`);
      setPreview(r.items ?? (r as any));
    } catch (e) {
      setErr(e);
    }
  };

  const pauseResume = async (paused: boolean) => {
    if (!selected) return;
    setErr(null);
    try {
      await api(`${M}/plans/${selected.id}/${paused ? 'pause' : 'resume'}`, {
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
      <PageHeader title="Preventive maintenance" lede="Publish calendar, completion, and meter-based plans. A completion plan's next due follows the previous closure. Pause stops generation and leaves the open order in place." />
      {filter.note && <p className="muted">{filter.note}. <a href="#/pm">Show all plans</a></p>}
      <form className="card" onSubmit={(e) => void create(e)}>
        <h3>New plan</h3>
        <label>Schedule
          <select value={kind} onChange={(e) => setKind(e.target.value as 'calendar' | 'completion')}>
            <option value="calendar">Calendar</option>
            <option value="completion">Completion</option>
          </select>
        </label>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label>Asset
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
            <option value="">—</option>
            {assets.items.map((a) => {
              const id = a.asset?.id ?? a.asset?.asset_id;
              return <option key={id} value={id}>{a.asset?.code} — {a.asset?.name}</option>;
            })}
          </select>
        </label>
        <ErrorBox err={assets.err ?? teams.err ?? procedures.err} />
        <label>Published procedure revision
          <select value={procRev} onChange={(e) => setProcRev(e.target.value)} required>
            <option value="">—</option>
            {procedures.items.flatMap((p) =>
              (p.revisions ?? [])
                .filter((r: any) => r.status === 'published')
                .map((r: any) => <option key={r.id} value={r.id}>{p.title} rev {r.revision_no}</option>),
            )}
          </select>
        </label>
        <label>Team
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
            <option value="">—</option>
            {teams.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <div className="row">
          <label>Every<input type="number" min={1} value={interval} onChange={(e) => setInterval(e.target.value)} /></label>
          <label>Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </label>
          <label>Anchor date<input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} /></label>
          <label>Time<input value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} pattern="([01]\d|2[0-3]):[0-5]\d" /></label>
        </div>
        <div className="row">
          <label>Expected part (optional)
            <select value={partId} onChange={(e) => setPartId(e.target.value)}>
              <option value="">None</option>
              {parts.items.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
            </select>
          </label>
          <label>Quantity<input type="number" min="0.0001" step="any" value={partQty} onChange={(e) => setPartQty(e.target.value)} /></label>
        </div>
        <p className="muted">A shortage is shown on the plan. Generation continues unless the site blocks on shortage.</p>
        <button type="submit">Create draft plan + revision</button>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={list.err} />
      <Table>
        <thead><tr><th>Title</th><th>Status</th><th>Next</th><th></th></tr></thead>
        <tbody>
          {list.items.map((p) => (
            <tr key={p.id}>
              <td>{p.title}</td>
              <td><Badge state={p.status} /></td>
              <td>{p.next_generate_at ?? '—'}</td>
              <td><button type="button" className="secondary" onClick={() => void open(p.id)}>Open</button></td>
            </tr>
          ))}
          {!list.items.length && emptyRow(4, list.loading, filter.note ? 'No matching plans.' : 'No plans yet.')}
        </tbody>
      </Table>
      {selected && (
        <Panel title={selected.title} onClose={() => setSelected(null)}>
          <p><Badge state={selected.status} /> v{selected.version} · next {selected.next_generate_at ?? '—'}</p>
          {selected.last_generation_issue && <p className="err">{selected.last_generation_issue}</p>}
          <label>Pause/resume reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="row">
            <button type="button" className="secondary" onClick={() => void pauseResume(true)}>Pause</button>
            <button type="button" className="secondary" onClick={() => void pauseResume(false)}>Resume</button>
          </div>
          <h4>Revisions</h4>
          <ul>
            {(selected.revisions ?? []).map((r: any) => (
              <li key={r.id} className="card">
                rev {r.revision_no ?? r.id} <Badge state={r.status} />
                {(r.expected_parts ?? []).length > 0 && <span className="muted"> · expected parts {(r.expected_parts as Array<{ quantity: number }>).map((p) => p.quantity).join(', ')}</span>}
                <div className="row">
                  {r.status === 'draft' && <button type="button" onClick={() => void publish(r.id)}>Publish</button>}
                  <button type="button" className="secondary" onClick={() => void runPreview(r.id)}>Preview schedule</button>
                </div>
              </li>
            ))}
          </ul>
          <h4>Occurrences</h4>
          <ul>
            {(selected.occurrences ?? []).map((o: { id: string; occurrence_key: string; status: string; reason?: string | null }) => (
              <li key={o.id}>{o.occurrence_key} <Badge state={o.status} /> {o.reason ?? ''}</li>
            ))}
            {!(selected.occurrences ?? []).length && <li className="muted">None yet.</li>}
          </ul>
          {preview.length > 0 && (
            <div className="card">
              <h4>Next occurrences</h4>
              <ol>{preview.map((p) => <li key={p.key}>{p.due_at} ({p.key})</li>)}</ol>
            </div>
          )}
          <ErrorBox err={err} />
        </Panel>
      )}
    </>
  );
}
