import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, isoLocal, uploadEvidence, useList, PageHeader, Table } from '../ui.tsx'

export function Inspections({ siteId }: { siteId: string }) {
  const results = useList<any>(`${M}/inspection-results?site_id=${siteId}`);
  const templates = useList<any>(`${M}/inspection-templates?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}`);
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [templateTitle, setTemplateTitle] = useState('Round check');
  const [assetId, setAssetId] = useState('');
  const [templateRevId, setTemplateRevId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const createTemplate = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const t = await api<any>(`${M}/inspection-templates`, { method: 'POST', body: JSON.stringify({ site_id: siteId, title: templateTitle }) });
      await api(`${M}/inspection-templates/${t.id}/revisions`, {
        method: 'POST',
        body: JSON.stringify({
          instructions: 'Record the round check.',
          checks: [
            { key: 'ok', label: 'Condition acceptable', type: 'pass_fail', required: true },
            { key: 'photo', label: 'Photo evidence', type: 'photo', required: true, evidence_required: true },
          ],
        }),
      });
      const pub = await api<any>(`${M}/inspection-templates/${t.id}/publish`, { method: 'POST', body: '{}' });
      setTemplateRevId(pub.id);
      templates.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<any>(`${M}/inspection-results`, {
        method: 'POST',
        body: JSON.stringify({
          template_revision_id: templateRevId,
          asset_id: assetId,
          client_submission_id: crypto.randomUUID(),
        }),
      });
      setSelected(r);
      results.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const open = async (id: string) => {
    setErr(null);
    try {
      setSelected(await api(`${M}/inspection-results/${id}`));
    } catch (e) {
      setErr(e);
    }
  };

  const submit = async () => {
    if (!selected) return;
    setErr(null);
    try {
      const checks = selected.checks ?? [];
      const payload = checks.map((c: any) => {
        const raw = values[c.key] ?? '';
        let value: unknown = raw;
        if (c.type === 'pass_fail') value = raw === 'pass';
        if (c.type === 'numeric') value = Number(raw);
        return { key: c.key, value, attachment_ids: [] };
      });
      await api(`${M}/inspection-results/${selected.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ observed_at: isoLocal(), values: payload }),
      });
      await open(selected.id);
      results.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const onPhoto = async (file: File | null) => {
    if (!file || !selected) return;
    setErr(null);
    try {
      await uploadEvidence('inspection_result', selected.id, file, 'photo');
      await open(selected.id);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageHeader title="Inspections" lede="Run checklists and capture evidence before submit." />
      <form className="card" onSubmit={(e) => void createTemplate(e)}>
        <h3>Publish a simple template</h3>
        <label>Title<input value={templateTitle} onChange={(e) => setTemplateTitle(e.target.value)} required /></label>
        <button type="submit">Create + publish</button>
      </form>
      <form className="card" onSubmit={(e) => void start(e)}>
        <h3>Start inspection</h3>
        <label>Published template revision
          <select value={templateRevId} onChange={(e) => setTemplateRevId(e.target.value)} required>
            <option value="">—</option>
            {templates.items.filter((t) => t.revision_id).map((t) => (
              <option key={t.revision_id} value={t.revision_id}>{t.title} rev {t.revision_no}</option>
            ))}
          </select>
        </label>
        <label>Asset
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required>
            <option value="">—</option>
            {assets.items.map((a) => <option key={a.asset?.id} value={a.asset?.id}>{a.asset?.code} — {a.asset?.name}</option>)}
          </select>
        </label>
        <button type="submit">Start</button>
        <ErrorBox err={err} />
      </form>
      <ErrorBox err={results.err} />
      <Table>
        <thead><tr><th>Asset</th><th>Status</th><th>Submitted</th><th></th></tr></thead>
        <tbody>
          {results.items.map((r) => (
            <tr key={r.id}>
              <td>{r.asset_id}</td>
              <td><Badge state={r.status} /></td>
              <td>{r.submitted_at ?? 'in progress'}</td>
              <td><button type="button" className="secondary" onClick={() => void open(r.id)}>Open</button></td>
            </tr>
          ))}
          {!results.items.length && emptyRow(4, results.loading)}
        </tbody>
      </Table>
      {selected && (
        <Panel title={`Inspection ${selected.id.slice(0, 8)}`} onClose={() => setSelected(null)}>
          <p><Badge state={selected.status} /> asset {selected.asset_id}</p>
          {(selected.checks ?? []).map((c: any) => (
            <label key={c.key}>
              {c.label} ({c.type})
              {c.type === 'pass_fail' ? (
                <select value={values[c.key] ?? ''} onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}>
                  <option value="">—</option>
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                </select>
              ) : c.type === 'photo' ? (
                <input type="file" accept="image/*" onChange={(e) => void onPhoto(e.target.files?.[0] ?? null)} />
              ) : (
                <input value={values[c.key] ?? ''} onChange={(e) => setValues({ ...values, [c.key]: e.target.value })} />
              )}
            </label>
          ))}
          {selected.status === 'in_progress' && <button type="button" onClick={() => void submit()}>Submit</button>}
          {selected.follow_up_request_id && <p className="muted">Follow-up request {selected.follow_up_request_id}</p>}
          <ErrorBox err={err} />
        </Panel>
      )}
    </>
  );
}
