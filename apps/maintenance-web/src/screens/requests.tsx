import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, PageHeader, Panel, Table, emptyRow, isoLocal, useList } from '../ui.tsx';

export function Requests({ siteId }: { siteId: string }) {
  const list = useList<any>(`${M}/requests?site_id=${siteId}`);
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [assetId, setAssetId] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftScope, setDraftScope] = useState('');
  const [teamId, setTeamId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [dupId, setDupId] = useState('');

  const open = async (id: string) => {
    setErr(null);
    try {
      const r = await api<any>(`${M}/requests/${id}`);
      setSelected(r);
      setDraftTitle(r.description.slice(0, 80));
      setDraftScope(r.description);
      setTeamId(teams.items[0]?.id ?? '');
    } catch (e) {
      setErr(e);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const created = await api<any>(`${M}/requests`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          site_id: siteId,
          asset_id: assetId || null,
          description,
          location_text: assetId ? null : location || null,
          observed_at: isoLocal(),
          proposed_priority: 'normal',
        }),
      });
      list.setItems((items) => [created, ...items]);
      setDescription('');
      setLocation('');
      setAssetId('');
    } catch (e) {
      setErr(e);
    }
  };

  const triage = async (body: Record<string, unknown>) => {
    if (!selected) return;
    setErr(null);
    try {
      const r = await api<{ request: any }>(`${M}/requests/${selected.id}/triage`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setSelected(r.request);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageHeader title="Requests" lede="Report faults and triage them into draft work orders. Asset id is optional when a location is provided." />
      <form className="card" onSubmit={(e) => void submit(e)}>
        <div className="row">
          <label>Asset id (optional)<input value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="uuid" /></label>
          <label>Location (required without asset)<input value={location} onChange={(e) => setLocation(e.target.value)} required={!assetId} /></label>
        </div>
        <label>Describe the fault<textarea value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} /></label>
        <button type="submit">Submit request</button>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={list.err} />
      <Table>
        <thead><tr><th>No.</th><th>State</th><th>Origin</th><th>Description</th></tr></thead>
        <tbody>
          {list.items.map((r) => (
            <tr key={r.id}>
              <td><button type="button" className="linkish" onClick={() => void open(r.id)}>{r.display_number}</button></td>
              <td><Badge state={r.state} /></td>
              <td>{r.origin}</td>
              <td>{r.description}</td>
            </tr>
          ))}
          {!list.items.length && emptyRow(4, list.loading, 'No requests yet.')}
        </tbody>
      </Table>
      {selected && (
        <Panel title={`Request ${selected.display_number} — triage`} onClose={() => setSelected(null)}>
          <p>{selected.description}</p>
          <p className="muted">State <Badge state={selected.state} /> · asset {selected.asset_id ?? 'none'} · location {selected.location_text ?? '—'}</p>
          {selected.rejection_reason && <p className="err">Rejected: {selected.rejection_reason}</p>}
          {selected.linked_work_order && <p className="muted">Linked order {selected.linked_work_order.display_number} ({selected.linked_work_order.state})</p>}
          <div className="row">
            <button type="button" className="secondary" onClick={() => void triage({ action: 'start_review', record_version: selected.version })}>Start review</button>
          </div>
          <div className="card" style={{ marginTop: '0.75rem' }}>
            <h4>Accept into draft order</h4>
            <label>Title<input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} /></label>
            <label>Scope<textarea value={draftScope} onChange={(e) => setDraftScope(e.target.value)} /></label>
            <label>Team
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                {teams.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <button
              type="button"
              disabled={!teamId}
              onClick={() => void triage({
                action: 'accept',
                record_version: selected.version,
                draft: {
                  title: draftTitle,
                  type: 'corrective',
                  priority: selected.proposed_priority ?? 'normal',
                  team_id: teamId,
                  scope: draftScope,
                  asset_id: selected.asset_id,
                  non_asset_category: selected.asset_id ? null : 'general',
                  non_asset_justification: selected.asset_id ? null : 'Reported without a registered asset',
                },
              })}
            >
              Accept
            </button>
          </div>
          <div className="card">
            <h4>Reject</h4>
            <label>Reason<textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} minLength={3} /></label>
            <button type="button" className="secondary" onClick={() => void triage({ action: 'reject', record_version: selected.version, reason: rejectReason })}>Reject</button>
          </div>
          <div className="card">
            <h4>Mark duplicate</h4>
            <label>Duplicate of request id<input value={dupId} onChange={(e) => setDupId(e.target.value)} /></label>
            <button
              type="button"
              className="secondary"
              onClick={() => void triage({
                action: 'mark_duplicate',
                record_version: selected.version,
                reason: 'Duplicate of an existing request',
                duplicate_of_request_id: dupId || null,
                duplicate_of_work_order_id: null,
              })}
            >
              Mark duplicate
            </button>
          </div>
          <ErrorBox err={err} />
        </Panel>
      )}
    </>
  );
}
