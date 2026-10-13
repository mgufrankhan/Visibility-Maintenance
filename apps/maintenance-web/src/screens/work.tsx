import { useState, type FormEvent } from 'react';
import { ApiError, M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, isoLocal, uploadEvidence, useList, PageHeader, Table } from '../ui.tsx'

export function WorkOrders({ siteId }: { siteId: string }) {
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
  const [planForm, setPlanForm] = useState({
    procedure_revision_id: '',
    planned_start: '',
    planned_end: '',
    safety_instructions: 'Wear PPE. Isolate energy before opening the housing.',
  });

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
      const steps = selected.procedure_snapshot?.steps ?? [];
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
      <PageHeader title="Work orders" lede="Plan, execute, and close work for this site." />
      <ErrorBox err={list.err ?? err} />
      {conflict && <p className="err" role="alert">Version conflict: {conflict}. Reloaded the current server state.</p>}
      <Table>
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
      </Table>
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
              {(selected.procedure_snapshot.steps as any[]).map((step) => (
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
