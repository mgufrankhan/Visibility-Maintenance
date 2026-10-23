import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { ApiError, M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, isoLocal, uploadEvidence, useList, PageHeader, Table } from '../ui.tsx'

interface ShiftWindow {
  code: string;
  label: string;
  start_minute: number;
  end_minute: number;
}

function siteDay(iso: string | null, timeZone: string): string {
  if (!iso) return 'unscheduled';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function upcomingDays(timeZone: string, count = 5): string[] {
  const today = siteDay(new Date().toISOString(), timeZone);
  const [year, month, day] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1, day! + index));
    return date.toISOString().slice(0, 10);
  });
}

function zonedInstant(day: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const extraDays = Math.floor(minuteOfDay / 1440);
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  const guess = Date.UTC(year!, month! - 1, date! + extraDays, hour, mins);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (asUtc - guess));
}

function minuteOfDay(iso: string, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function inShift(iso: string | null, day: string, shift: ShiftWindow, timeZone: string): boolean {
  if (!iso || siteDay(iso, timeZone) !== day) return false;
  const minute = minuteOfDay(iso, timeZone);
  if (shift.end_minute > shift.start_minute) return minute >= shift.start_minute && minute < shift.end_minute;
  return minute >= shift.start_minute || minute < shift.end_minute;
}

function stepShown(step: any, steps: any[], values: Record<string, string>): boolean {
  const rule = step.visible_when;
  if (!rule) return true;
  const raw = values[rule.key] ?? '';
  if (rule.when === 'failed') return raw === 'fail' || raw === 'false';
  if (rule.when === 'passed') return raw === 'pass' || raw === 'true';
  if (rule.when === 'outside_limits') {
    const prior = steps.find((item) => item.key === rule.key);
    const value = Number(raw);
    if (!prior || prior.type !== 'numeric' || raw === '' || Number.isNaN(value)) return false;
    const low = prior.min == null || value >= prior.min;
    const high = prior.max == null || value <= prior.max;
    return !(low && high);
  }
  return false;
}

const WORK_STATES = ['draft', 'pending_approval', 'ready', 'in_progress', 'on_hold', 'pending_review', 'closed', 'cancelled'];

function workOrigin(item: { type?: string; source_request_id?: string | null; plan_occurrence_id?: string | null; follow_up_of_id?: string | null; non_asset_category?: string | null }): string {
  if (item.non_asset_category === 'shutdown') return 'Shutdown';
  if (item.follow_up_of_id || item.type === 'follow_up') return 'Follow-up';
  if (item.plan_occurrence_id || item.type === 'preventive') return 'PM';
  if (item.type === 'inspection') return 'Inspection';
  if (item.source_request_id) return 'Request';
  return 'Manual';
}

function workAsset(item: { asset_snapshot?: { code?: string; name?: string } | null; non_asset_category?: string | null }): string {
  const snapshot = item.asset_snapshot;
  if (snapshot?.code) return snapshot.name ? `${snapshot.code} — ${snapshot.name}` : snapshot.code;
  if (item.non_asset_category === 'shutdown') return 'Shutdown';
  return '—';
}

function workFilter(siteId: string, query: string): { path: string; note: string | null } {
  const params = new URLSearchParams(query);
  const search = new URLSearchParams({ site_id: siteId });
  const notes: string[] = [];
  if (params.get('overdue') === 'true') {
    search.set('overdue', 'true');
    notes.push('Overdue work only');
  }
  const state = params.get('state');
  if (state && state.split(',').every((item) => WORK_STATES.includes(item))) {
    search.set('state', state);
    notes.push(state === 'ready' ? 'Ready orders only' : `State ${state.split(',').join(', ')}`);
  }
  return { path: `${M}/work-orders?${search.toString()}`, note: notes.length ? notes.join(' · ') : null };
}

export function WorkOrders({ siteId, timezone, query }: { siteId: string; timezone: string; query: string }) {
  const filter = workFilter(siteId, query);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}&limit=100`);
  const [searchText, setSearchText] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [assetId, setAssetId] = useState('');
  const listParams = new URLSearchParams(filter.path.split('?')[1] ?? '');
  if (appliedSearch.trim()) listParams.set('q', appliedSearch.trim());
  if (assetId) listParams.set('asset_id', assetId);
  const list = useList<any>(`${M}/work-orders?${listParams.toString()}`);
  const procedures = useList<any>(`${M}/procedures?site_id=${siteId}`);
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [laborMinutes, setLaborMinutes] = useState('30');
  const [laborNote, setLaborNote] = useState('');
  const [comment, setComment] = useState('');
  const [completion, setCompletion] = useState({ corrective_action: '', cause_code: 'WEAR', observed_symptoms: '' });
  const [stepValues, setStepValues] = useState<Record<string, string>>({});
  const [view, setView] = useState<'list' | 'board'>('list');
  const [dragging, setDragging] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<any>(null);
  const [captureSymptom, setCaptureSymptom] = useState('');
  const [captureNotes, setCaptureNotes] = useState('');
  const [shifts, setShifts] = useState<ShiftWindow[]>([]);
  const [childId, setChildId] = useState('');
  const [shutdownTitle, setShutdownTitle] = useState('Planned shutdown');
  const [shutdownTeam, setShutdownTeam] = useState('');
  const [exemptCancel, setExemptCancel] = useState(false);
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const [planForm, setPlanForm] = useState({
    procedure_revision_id: '',
    planned_start: '',
    planned_end: '',
    safety_instructions: 'Wear PPE. Isolate energy before opening the housing.',
  });

  useEffect(() => {
    api<{ shifts?: ShiftWindow[] }>(`${M}/sites/${siteId}/settings`)
      .then((settings) => setShifts(settings.shifts ?? []))
      .catch(() => setShifts([]));
  }, [siteId]);

  const open = async (id: string) => {
    setErr(null);
    setConflict(null);
    try {
      const wo = await api<any>(`${M}/work-orders/${id}`);
      setSelected(wo);
      setPlanForm({
        procedure_revision_id: wo.procedure_revision_id ?? '',
        planned_start: wo.planned_start ? wo.planned_start.slice(0, 16) : '',
        planned_end: wo.planned_end ? wo.planned_end.slice(0, 16) : '',
        safety_instructions: wo.safety_instructions ?? wo.procedure_snapshot?.safety_instructions ?? 'Wear PPE. Isolate energy before opening the housing.',
      });
      const vals: Record<string, string> = {};
      for (const step of wo.procedure_snapshot?.steps ?? []) {
        const existing = (wo.task_results ?? []).find((r: any) => r.step_key === step.key);
        vals[step.key] = existing?.value === true ? 'pass' : existing?.value === false ? 'fail' : String(existing?.value ?? '');
      }
      setStepValues(vals);
    } catch (e) {
      setErr(e);
    }
  };

  const loadBriefing = async () => {
    if (!selected?.asset_id) return;
    setErr(null);
    try {
      setBriefing(await api(`${M}/briefings?asset_id=${selected.asset_id}`));
    } catch (e) {
      setErr(e);
    }
  };

  const saveCapture = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      await api(`${M}/captures`, {
        method: 'POST',
        body: JSON.stringify({
          site_id: siteId,
          work_order_id: selected.id,
          fields: { symptom: captureSymptom || null, notes: captureNotes || null, failure_code: null, cause: null, action: null },
        }),
      });
      setCaptureSymptom('');
      setCaptureNotes('');
    } catch (e) {
      setErr(e);
    }
  };

  const savePlanning = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
      await api(`${M}/work-orders/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          record_version: selected.version,
          procedure_revision_id: planForm.procedure_revision_id || null,
          planned_start: toIso(planForm.planned_start),
          planned_end: toIso(planForm.planned_end),
          safety_instructions: planForm.safety_instructions || null,
        }),
      });
      await open(selected.id);
      list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict(e.message);
        await open(selected.id);
      } else setErr(e);
    }
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!selected) return;
    setErr(null);
    setConflict(null);
    try {
      await api(`${M}/work-orders/${selected.id}/transitions`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          record_version: selected.version,
          reason: action === 'cancel' || action === 'return_for_rework' || action === 'hold' || action === 'reopen' ? (extra.reason as string) ?? 'Action from web' : null,
          ...extra,
        }),
      });
      await open(selected.id);
      list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict(e.message);
        await open(selected.id);
      } else setErr(e);
    }
  };

  const saveResults = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      const steps = (selected.procedure_snapshot?.steps ?? []).filter((step: any) => stepShown(step, selected.procedure_snapshot.steps, stepValues));
      const results = steps.map((step: any) => {
        const raw = stepValues[step.key] ?? '';
        let value: unknown = raw;
        if (step.type === 'pass_fail') value = raw === 'pass' || raw === 'true';
        if (step.type === 'numeric') value = Number(raw);
        if (step.type === 'acknowledgment') value = raw === 'true' || raw === 'yes';
        return { key: step.key, value };
      });
      await api(`${M}/work-orders/${selected.id}/results`, { method: 'POST', body: JSON.stringify({ results }) });
      await open(selected.id);
    } catch (e) {
      setErr(e);
    }
  };

  const addLabor = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      await api(`${M}/work-orders/${selected.id}/labor`, {
        method: 'POST',
        body: JSON.stringify({
          started_at: isoLocal(new Date(Date.now() - Number(laborMinutes) * 60_000)),
          duration_minutes: Number(laborMinutes),
          note: laborNote || null,
        }),
      });
      await open(selected.id);
      setLaborNote('');
    } catch (e) {
      setErr(e);
    }
  };

  const addComment = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      await api(`${M}/work-orders/${selected.id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) });
      await open(selected.id);
      setComment('');
    } catch (e) {
      setErr(e);
    }
  };

  const moveOnBoard = async (id: string, day: string, shift: ShiftWindow) => {
    const current = list.items.find((item) => item.id === id);
    if (!current || ['in_progress', 'on_hold', 'pending_review', 'closed', 'cancelled'].includes(current.state)) {
      setErr(new Error('Schedule changes are available before work starts. Reload the order if it has changed.'));
      return;
    }
    setErr(null);
    setConflict(null);
    try {
      const endMinute = shift.end_minute > shift.start_minute ? shift.end_minute : shift.end_minute + 1440;
      await api(`${M}/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          record_version: current.version,
          planned_start: zonedInstant(day, shift.start_minute, timezone).toISOString(),
          planned_end: zonedInstant(day, endMinute, timezone).toISOString(),
        }),
      });
      list.reload();
      if (selected?.id === id) await open(id);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409 || e.status === 412)) {
        setConflict(e.message);
        list.reload();
      } else setErr(e);
    }
  };

  const signCompletion = async () => {
    if (!selected?.procedure_snapshot_hash) return;
    setErr(null);
    try {
      await api(`${M}/work-orders/${selected.id}/signature`, {
        method: 'POST',
        body: JSON.stringify({ snapshot_hash: selected.procedure_snapshot_hash, record_version: selected.version }),
      });
      await open(selected.id);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.code === 'snapshot_hash_mismatch')) {
        setConflict(e.message);
        await open(selected.id);
      } else setErr(e);
    }
  };

  const createShutdown = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const created = await api<{ id: string }>(`${M}/work-orders`, {
        method: 'POST',
        body: JSON.stringify({
          site_id: siteId,
          title: shutdownTitle,
          type: 'inspection',
          priority: 'normal',
          team_id: shutdownTeam,
          scope: 'Coordinate the shutdown. Each asset keeps its own order.',
          asset_id: null,
          non_asset_category: 'shutdown',
          non_asset_justification: 'Planned stop across more than one asset',
        }),
      });
      list.reload();
      await open(created.id);
    } catch (e) {
      setErr(e);
    }
  };

  const linkChild = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !childId.trim()) return;
    setErr(null);
    try {
      await api(`${M}/work-orders/${selected.id}/children`, { method: 'POST', body: JSON.stringify({ work_order_id: childId.trim() }) });
      setChildId('');
      await open(selected.id);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const onPhoto = async (file: File | null, stepKey?: string) => {
    if (!file || !selected) return;
    setErr(null);
    try {
      await uploadEvidence('work_order', selected.id, file, stepKey ?? null);
      await open(selected.id);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageHeader
        title="Work orders"
        lede="Plan, execute, and close work for this site."
        actions={
          <button type="button" className="secondary" onClick={() => setView(view === 'list' ? 'board' : 'list')}>
            {view === 'list' ? 'Planning board' : 'List'}
          </button>
        }
      />
      {filter.note && <p className="muted">{filter.note}. <a href="#/work">Show all work orders</a></p>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); setAppliedSearch(searchText); }}>
        <div className="row">
          <label>Search
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Title or order number" />
          </label>
          <label>Asset
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Any</option>
              {assets.items.map((profile) => {
                const asset = profile.asset;
                if (!asset?.id) return null;
                return <option key={asset.id} value={asset.id}>{asset.code} — {asset.name}</option>;
              })}
            </select>
          </label>
          <button type="submit">Search</button>
          {(appliedSearch || assetId) && (
            <button type="button" className="secondary" onClick={() => { setSearchText(''); setAppliedSearch(''); setAssetId(''); }}>Clear</button>
          )}
        </div>
      </form>
      <ErrorBox err={list.err ?? err} />
      {view === 'list' && (
        <form className="card" onSubmit={(e) => void createShutdown(e)}>
          <h4>New shutdown</h4>
          <p className="muted">A coordinating order with no asset. Link one child order per asset afterwards.</p>
          <div className="row">
            <label>Title<input value={shutdownTitle} onChange={(e) => setShutdownTitle(e.target.value)} required /></label>
            <label>Team
              <select value={shutdownTeam} onChange={(e) => setShutdownTeam(e.target.value)} required>
                <option value="">—</option>
                {teams.items.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </label>
          </div>
          <button type="submit">Create shutdown</button>
        </form>
      )}
      {conflict && <p className="err" role="alert">Version conflict: {conflict}. Reloaded the current server state.</p>}
      {view === 'board' && (
        <PlanningBoard
          items={list.items}
          days={upcomingDays(timezone)}
          shifts={shifts.length ? shifts : [{ code: 'day', label: 'Day', start_minute: 0, end_minute: 1440 }]}
          timezone={timezone}
          dragging={dragging}
          onDragStart={setDragging}
          onDrop={(id, day, shift) => void moveOnBoard(id, day, shift)}
          onOpen={(id) => void open(id)}
        />
      )}
      {view === 'list' && <Table>
        <thead><tr><th>No.</th><th>Title</th><th>Asset</th><th>Origin</th><th>State</th><th>Assignee</th><th>Due</th></tr></thead>
        <tbody>
          {list.items.map((w) => (
            <tr key={w.id}>
              <td><button className="secondary" type="button" onClick={() => void open(w.id)}>{w.display_number}</button></td>
              <td>{w.title}</td>
              <td>{workAsset(w)}</td>
              <td>{workOrigin(w)}</td>
              <td><Badge state={w.state} />{w.overdue ? ' overdue' : ''}</td>
              <td>{w.assignee_id ?? 'team queue'}</td>
              <td>{w.due_at ?? '—'}</td>
            </tr>
          ))}
          {!list.items.length && emptyRow(7, list.loading, filter.note || appliedSearch || assetId ? 'No matching work orders.' : 'No records.')}
        </tbody>
      </Table>}
      {selected && (
        <Panel title={`WO-${selected.display_number} ${selected.title}`} onClose={() => setSelected(null)}>
          <p><Badge state={selected.state} /> v{selected.version}</p>
          <p>{selected.scope}</p>
          {selected.non_asset_category === 'shutdown' && !selected.asset_id && (
            <form className="card" onSubmit={(e) => void linkChild(e)}>
              <h4>Shutdown children</h4>
              <p className="muted">Each child keeps its own labor, evidence and downtime. The shutdown cannot close while a child is open.</p>
              <ul>
                {(selected.children ?? []).map((child: { id: string; display_number: number; title: string; state: string }) => (
                  <li key={child.id}>WO-{child.display_number} {child.title} <Badge state={child.state} /></li>
                ))}
                {!selected.children?.length && <li className="muted">No children linked</li>}
              </ul>
              <label>Child work order id<input value={childId} onChange={(e) => setChildId(e.target.value)} /></label>
              <button type="submit" disabled={!childId.trim()}>Link child</button>
            </form>
          )}
          {selected.asset_id && (
            <div className="card">
              <h4>Asset briefing</h4>
              <button type="button" className="secondary" onClick={() => void loadBriefing()}>Load briefing</button>
              {briefing && (
                <ul>
                  <li>Open orders: {(briefing.open_orders ?? []).map((order: { display_number: string }) => order.display_number).join(', ') || 'none'}</li>
                  <li>Validated failures: {briefing.validated_failure_count ?? 0}</li>
                  <li>Procedure: {briefing.procedure_revision_id ?? 'none'}</li>
                  <li>Parts ledger: {briefing.parts?.present ? 'present' : 'absent'}</li>
                </ul>
              )}
            </div>
          )}
          {selected.state === 'in_progress' && (
            <form className="card" onSubmit={(e) => void saveCapture(e)}>
              <h4>Structured capture</h4>
              <p className="muted">Marked fields become a review proposal. They do not change this work order.</p>
              <label>Symptom<input value={captureSymptom} onChange={(e) => setCaptureSymptom(e.target.value)} /></label>
              <label>Notes<textarea value={captureNotes} onChange={(e) => setCaptureNotes(e.target.value)} /></label>
              <button type="submit" disabled={!captureSymptom && !captureNotes}>Save capture</button>
            </form>
          )}
          {selected.procedure_snapshot && (
            <p className="muted">
              Issued procedure {selected.procedure_snapshot.title} rev {selected.procedure_snapshot.revision_no}
              {selected.procedure_snapshot.safety_instructions ? ` — ${selected.procedure_snapshot.safety_instructions}` : ''}
            </p>
          )}
          {['draft', 'pending_approval', 'returned'].includes(selected.state) && (
            <form className="card" onSubmit={(e) => void savePlanning(e)}>
              <h4>Planning (required before approve)</h4>
              <label>Published procedure revision
                <select
                  value={planForm.procedure_revision_id}
                  onChange={(e) => setPlanForm({ ...planForm, procedure_revision_id: e.target.value })}
                  required
                >
                  <option value="">—</option>
                  {procedures.items.flatMap((p) =>
                    (p.revisions ?? [])
                      .filter((r: any) => r.status === 'published')
                      .map((r: any) => <option key={r.id} value={r.id}>{p.title} rev {r.revision_no}</option>),
                  )}
                </select>
              </label>
              <div className="row">
                <label>Planned start<input type="datetime-local" value={planForm.planned_start} onChange={(e) => setPlanForm({ ...planForm, planned_start: e.target.value })} required /></label>
                <label>Planned end<input type="datetime-local" value={planForm.planned_end} onChange={(e) => setPlanForm({ ...planForm, planned_end: e.target.value })} required /></label>
              </div>
              <label>Safety instructions<textarea value={planForm.safety_instructions} onChange={(e) => setPlanForm({ ...planForm, safety_instructions: e.target.value })} required /></label>
              <button type="submit">Save planning</button>
            </form>
          )}
          {(selected.available_actions ?? []).includes('cancel') && (
            <label className="muted">
              <input type="checkbox" checked={exemptCancel} onChange={(e) => setExemptCancel(e.target.checked)} />
              Approved exemption. This cancellation does not move a completion schedule.
            </label>
          )}
          <div className="row">
            {(selected.available_actions ?? []).map((a: string) => {
              if (a === 'submit_completion') {
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => void act(a, { completion: { ...completion, acknowledgments: [] } })}
                  >
                    submit completion
                  </button>
                );
              }
              if (a === 'close') {
                return <button key={a} type="button" onClick={() => void act(a, { closure_outcome: 'restored' })}>close</button>;
              }
              if (a === 'cancel') {
                return <button key={a} type="button" onClick={() => void act(a, { exemption: exemptCancel })}>cancel</button>;
              }
              return <button key={a} type="button" onClick={() => void act(a)}>{a.replace(/_/g, ' ')}</button>;
            })}
          </div>
          {(selected.available_actions ?? []).includes('submit_completion') && selected.procedure_snapshot?.signature_required && (
            <div className="card">
              <h4>Completion signature</h4>
              {selected.completion_signature?.snapshot_hash === selected.procedure_snapshot_hash ? (
                <p>Signed by {selected.completion_signature.signer_id} at {selected.completion_signature.signed_at}.</p>
              ) : (
                <button type="button" onClick={() => void signCompletion()}>Sign issued procedure</button>
              )}
            </div>
          )}
          {(selected.available_actions ?? []).includes('submit_completion') && (
            <div className="card">
              <h4>Completion details</h4>
              <label>Corrective action<textarea value={completion.corrective_action} onChange={(e) => setCompletion({ ...completion, corrective_action: e.target.value })} /></label>
              <label>Cause code<input value={completion.cause_code} onChange={(e) => setCompletion({ ...completion, cause_code: e.target.value })} /></label>
              <label>Symptoms<textarea value={completion.observed_symptoms} onChange={(e) => setCompletion({ ...completion, observed_symptoms: e.target.value })} /></label>
            </div>
          )}
          {(selected.procedure_snapshot?.steps?.length ?? 0) > 0 && (
            <form className="card" onSubmit={(e) => void saveResults(e)}>
              <h4>Procedure checks</h4>
              {(selected.procedure_snapshot.steps as any[]).filter((step) => stepShown(step, selected.procedure_snapshot.steps, stepValues)).map((step) => (
                <label key={step.key}>
                  {step.label} ({step.type})
                  {step.type === 'pass_fail' ? (
                    <select value={stepValues[step.key] ?? ''} onChange={(e) => setStepValues({ ...stepValues, [step.key]: e.target.value })}>
                      <option value="">—</option>
                      <option value="pass">Pass</option>
                      <option value="fail">Fail</option>
                    </select>
                  ) : step.type === 'photo' ? (
                    <input type="file" accept="image/*" onChange={(e) => void onPhoto(e.target.files?.[0] ?? null, step.key)} />
                  ) : (
                    <input value={stepValues[step.key] ?? ''} onChange={(e) => setStepValues({ ...stepValues, [step.key]: e.target.value })} />
                  )}
                </label>
              ))}
              <button type="submit">Save results</button>
            </form>
          )}
          {!(selected.non_asset_category === 'shutdown' && !selected.asset_id) && <form className="card" onSubmit={(e) => void addLabor(e)}>
            <h4>Labor</h4>
            <div className="row">
              <label>Minutes<input type="number" min={1} value={laborMinutes} onChange={(e) => setLaborMinutes(e.target.value)} /></label>
              <label>Note<input value={laborNote} onChange={(e) => setLaborNote(e.target.value)} /></label>
            </div>
            <button type="submit">Add labor</button>
            <ul>{(selected.labor ?? []).map((l: any) => <li key={l.id}>{l.duration_minutes} min {l.note ?? ''}</li>)}</ul>
          </form>}
          {!(selected.non_asset_category === 'shutdown' && !selected.asset_id) && <div className="card">
            <h4>Evidence</h4>
            <label>Photo / document<input type="file" accept="image/*,.pdf,.txt,.md" onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} /></label>
            <ul>{(selected.attachments ?? []).map((a: any) => <li key={a.id}>{a.file_name} <Badge state={a.status} /></li>)}</ul>
          </div>}
          <form className="card" onSubmit={(e) => void addComment(e)}>
            <h4>Comments</h4>
            <label>Comment<textarea value={comment} onChange={(e) => setComment(e.target.value)} required /></label>
            <button type="submit">Add comment</button>
            <ul>{(selected.comments ?? []).map((c: any) => <li key={c.id}>{c.body}</li>)}</ul>
          </form>
          <div className="card">
            <h4>Timeline</h4>
            <ul>{(selected.transitions ?? []).map((t: any, i: number) => (
              <li key={i}>
                {t.action}: {t.from_state ?? '—'} → {t.to_state}
                {t.detail?.exemption ? ' · approved exemption' : ''}
                {typeof t.detail?.due_at === 'string' ? ` · due ${t.detail.due_at}` : ''}
              </li>
            ))}</ul>
          </div>
        </Panel>
      )}
    </>
  );
}

function boardMark(item: { non_asset_category?: string | null; asset_id?: string | null; parent_id?: string | null }): string | null {
  if (item.non_asset_category === 'shutdown' && !item.asset_id) return 'Shutdown';
  if (item.parent_id) return 'Shutdown child';
  return null;
}

function PlanningBoard({
  items,
  days,
  shifts,
  timezone,
  dragging,
  onDragStart,
  onDrop,
  onOpen,
}: {
  items: any[];
  days: string[];
  shifts: ShiftWindow[];
  timezone: string;
  dragging: string | null;
  onDragStart: (id: string) => void;
  onDrop: (id: string, day: string, shift: ShiftWindow) => void;
  onOpen: (id: string) => void;
}) {
  const openItems = items.filter((item) => !['closed', 'cancelled'].includes(item.state));
  const unscheduled = openItems.filter((item) => !item.planned_start);
  const drop = (event: DragEvent, day: string, shift: ShiftWindow) => {
    event.preventDefault();
    if (dragging) onDrop(dragging, day, shift);
  };
  return (
    <div className="plan-board">
      <section className="plan-day">
        <h3>Unscheduled</h3>
        {unscheduled.map((item) => (
          <article
            key={item.id}
            className="plan-card"
            draggable={!['in_progress', 'on_hold', 'pending_review'].includes(item.state)}
            onDragStart={() => onDragStart(item.id)}
          >
            <button type="button" className="secondary" onClick={() => onOpen(item.id)}>WO-{item.display_number}</button>
            <span>{item.title}</span>
            {boardMark(item) && <span className="muted">{boardMark(item)}</span>}
            <span className="muted">{item.assignee_id ?? 'team queue'}</span>
          </article>
        ))}
        {!unscheduled.length && <p className="muted">None</p>}
      </section>
      {days.map((day) => (
        <section key={day} className="plan-day">
          <h3>{day}</h3>
          {shifts.map((shift) => {
            const cards = openItems.filter((item) => inShift(item.planned_start, day, shift, timezone));
            return (
              <div
                key={shift.code}
                className="plan-shift"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => drop(event, day, shift)}
              >
                <p className="muted">{shift.label}</p>
                {cards.map((item) => (
                  <article
                    key={item.id}
                    className="plan-card"
                    draggable={!['in_progress', 'on_hold', 'pending_review'].includes(item.state)}
                    onDragStart={() => onDragStart(item.id)}
                  >
                    <button type="button" className="secondary" onClick={() => onOpen(item.id)}>WO-{item.display_number}</button>
                    <span>{item.title}</span>
                    {boardMark(item) && <span className="muted">{boardMark(item)}</span>}
                    <span className="muted">{item.assignee_id ?? 'team queue'}</span>
                  </article>
                ))}
              </div>
            );
          })}
          {openItems
            .filter((item) => siteDay(item.planned_start, timezone) === day && !shifts.some((shift) => inShift(item.planned_start, day, shift, timezone)))
            .map((item) => (
              <article
                key={item.id}
                className="plan-card"
                draggable={!['in_progress', 'on_hold', 'pending_review'].includes(item.state)}
                onDragStart={() => onDragStart(item.id)}
              >
                <button type="button" className="secondary" onClick={() => onOpen(item.id)}>WO-{item.display_number}</button>
                <span>{item.title}</span>
                {boardMark(item) && <span className="muted">{boardMark(item)}</span>}
                <span className="muted">Outside the shift windows</span>
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}
