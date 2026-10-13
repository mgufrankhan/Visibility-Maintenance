import { useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Panel, emptyRow, useList, PageHeader, Table } from '../ui.tsx'

export function Assets({ siteId }: { siteId: string }) {
  const list = useList<any>(`${M}/asset-profiles?site_id=${siteId}`);
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [criticality, setCriticality] = useState('c_standard');
  const [maintainable, setMaintainable] = useState(true);

  const open = async (assetId: string) => {
    setErr(null);
    try {
      const a = await api<any>(`${M}/asset-profiles/${assetId}`);
      setSelected(a);
      setCriticality(a.profile?.criticality ?? 'c_standard');
      setMaintainable(a.profile?.maintainable ?? true);
    } catch (e) {
      setErr(e);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr(null);
    try {
      const next = await api(`${M}/asset-profiles/${selected.asset.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          maintainable,
          criticality,
          team_id: selected.profile?.team_id ?? null,
          warranty_reference: selected.profile?.warranty_reference ?? null,
          service_interval_defaults: selected.profile?.service_interval_defaults ?? {},
          failure_taxonomy: selected.profile?.failure_taxonomy ?? [],
          document_links: selected.profile?.document_links ?? [],
          record_version: selected.profile?.version,
        }),
      });
      setSelected(next);
      list.reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageHeader title="Assets" lede="Maintainable assets from the canonical registry for this site." />
      <p className="muted">Identity comes from the shared registry. Maintenance stores only profiles and business records — never a second equipment master.</p>
      <ErrorBox err={list.err ?? err} />
      <Table>
        <thead><tr><th>Code</th><th>Name</th><th>Lifecycle</th><th>Criticality</th><th></th></tr></thead>
        <tbody>
          {list.items.map((a) => (
            <tr key={a.asset?.id}>
              <td>{a.asset?.code}</td>
              <td>{a.asset?.name}</td>
              <td><Badge state={a.asset?.lifecycle ?? 'unknown'} /></td>
              <td>{a.profile?.criticality ?? '—'}</td>
              <td><button type="button" className="secondary" onClick={() => void open(a.asset.id)}>Open</button></td>
            </tr>
          ))}
          {!list.items.length && emptyRow(5, list.loading, 'No assets in this site yet.')}
        </tbody>
      </Table>
      {selected && (
        <Panel title={`${selected.asset.code} — ${selected.asset.name}`} onClose={() => setSelected(null)}>
          <p className="muted">
            Registry identity v{selected.asset.version} · source {selected.identity_source} · QR token present for authenticated scan.
            Location {selected.asset.location ?? '—'}.
          </p>
          {selected.summary && <p className="muted">Open work {selected.summary.open_work_orders ?? 0}, open requests {selected.summary.open_requests ?? 0}</p>}
          <form onSubmit={(e) => void save(e)}>
            <label><span><input type="checkbox" checked={maintainable} onChange={(e) => setMaintainable(e.target.checked)} /> Maintainable</span></label>
            <label>Criticality
              <select value={criticality} onChange={(e) => setCriticality(e.target.value)}>
                <option value="a_critical">A critical</option>
                <option value="b_important">B important</option>
                <option value="c_standard">C standard</option>
              </select>
            </label>
            <button type="submit">Save profile</button>
          </form>
          <ErrorBox err={err} />
        </Panel>
      )}
    </>
  );
}
