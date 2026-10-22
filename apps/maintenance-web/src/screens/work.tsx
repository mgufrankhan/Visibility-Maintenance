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

export function WorkOrders({ siteId, timezone }: { siteId: string; timezone: string }) {
  const list = useList<any>(`${M}/work-orders?site_id=${siteId}`);
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
  const [shifts, setShifts] = useState<ShiftWindow[]>([]);
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
          reason: action === 'cancel' || action === 'return_for_rework' || action === 'hold' ? (extra.reason as string) ?? 'Action from web' : null,
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
      <ErrorBox err={list.err ?? err} />
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
        <thead><tr><th>No.</th><th>Title</th><th>State</th><th>Assignee</th><th>Due</th></tr></thead>
        <tbody>
          {list.items.map((w) => (
            <tr key={w.id}>
              <td><button className="secondary" type="button" onClick={() => void open(w.id)}>{w.display_number}</button></td>
              <td>{w.title}</td>
              <td><Badge state={w.state} />{w.overdue ? ' overdue' : ''}</td>
              <td>{w.assignee_id ?? 'team queue'}</td>
              <td>{w.due_at ?? '—'}</td>
            </tr>
          ))}
          {!list.items.length && emptyRow(5, list.loading)}
        </tbody>
      </Table>}
      {selected && (
        <Panel title={`WO-${selected.display_number} ${selected.title}`} onClose={() => setSelected(null)}>
          <p><Badge state={selected.state} /> v{selected.version}</p>
          <p>{selected.scope}</p>
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
          <form className="card" onSubmit={(e) => void addLabor(e)}>
            <h4>Labor</h4>
            <div className="row">
              <label>Minutes<input type="number" min={1} value={laborMinutes} onChange={(e) => setLaborMinutes(e.target.value)} /></label>
              <label>Note<input value={laborNote} onChange={(e) => setLaborNote(e.target.value)} /></label>
            </div>
            <button type="submit">Add labor</button>
            <ul>{(selected.labor ?? []).map((l: any) => <li key={l.id}>{l.duration_minutes} min {l.note ?? ''}</li>)}</ul>
          </form>
          <div className="card">
            <h4>Evidence</h4>
            <label>Photo / document<input type="file" accept="image/*,.pdf,.txt,.md" onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} /></label>
            <ul>{(selected.attachments ?? []).map((a: any) => <li key={a.id}>{a.file_name} <Badge state={a.status} /></li>)}</ul>
          </div>
          <form className="card" onSubmit={(e) => void addComment(e)}>
            <h4>Comments</h4>
            <label>Comment<textarea value={comment} onChange={(e) => setComment(e.target.value)} required /></label>
            <button type="submit">Add comment</button>
            <ul>{(selected.comments ?? []).map((c: any) => <li key={c.id}>{c.body}</li>)}</ul>
          </form>
          <div className="card">
            <h4>Timeline</h4>
            <ul>{(selected.transitions ?? []).map((t: any, i: number) => <li key={i}>{t.action}: {t.from_state ?? '—'} → {t.to_state}</li>)}</ul>
          </div>
        </Panel>
      )}
    </>
  );
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
                <span className="muted">Outside the shift windows</span>
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}
