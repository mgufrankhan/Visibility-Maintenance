import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, useList } from '../ui.tsx';

export function Plans({ siteId }: { siteId: string }) {
  const list = useList<any>(`${M}/plans?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}`);
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const procedures = useList<any>(`${M}/procedures?site_id=${siteId}`);
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
        body: JSON.stringify({ site_id: siteId, asset_id: assetId, title, trigger_kind: 'calendar' }),
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
          trigger: { type: 'calendar', unit, interval: Number(interval), anchor_date: anchor, time_of_day: timeOfDay },
          effective_from: anchor,
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
      <h2>Preventive maintenance</h2>
      <form className="card" onSubmit={(e) => void create(e)}>
        <h3>New calendar plan</h3>
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
        <button type="submit">Create draft plan + revision</button>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={list.err} />
      <table>
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
          {!list.items.length && emptyRow(4, list.loading, 'No plans yet.')}
        </tbody>
      </table>
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
                <div className="row">
                  {r.status === 'draft' && <button type="button" onClick={() => void publish(r.id)}>Publish</button>}
                  <button type="button" className="secondary" onClick={() => void runPreview(r.id)}>Preview schedule</button>
                </div>
              </li>
            ))}
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
