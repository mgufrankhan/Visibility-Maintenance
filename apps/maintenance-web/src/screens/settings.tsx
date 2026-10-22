import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { M, api, type Me } from '../api.ts';
import { Badge, ErrorBox, emptyRow, useList, PageHeader, Table } from '../ui.tsx'

export function Settings({ siteId, me }: { siteId: string; me: Me | null }) {
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const roles = useList<any>(`${M}/role-assignments`);
  const [ent, setEnt] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [teamName, setTeamName] = useState('');
  const [licenseJson, setLicenseJson] = useState('');
  const [procTitle, setProcTitle] = useState('Visual check');
  const [signatureRequired, setSignatureRequired] = useState(false);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('technician');
  const [pmInitial, setPmInitial] = useState<'ready' | 'pending_approval'>('ready');
  const [shiftCode, setShiftCode] = useState('day');
  const [shiftLabel, setShiftLabel] = useState('Day');
  const [shiftStart, setShiftStart] = useState('480');
  const [shiftEnd, setShiftEnd] = useState('960');

  const perms = useMemo(() => me?.sites.find((s) => s.site_id === siteId)?.permissions ?? [], [me, siteId]);

  useEffect(() => {
    api(`${M}/entitlements`).then(setEnt).catch(setErr);
    api(`${M}/sites/${siteId}/settings`).then((s: any) => {
      setSettings(s);
      setPmInitial(s.pm_initial_state ?? 'ready');
    }).catch(setErr);
  }, [siteId]);

  const createTeam = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/teams`, { method: 'POST', body: JSON.stringify({ site_id: siteId, name: teamName, member_ids: [] }) });
      setTeamName('');
      teams.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api(`${M}/role-assignments`, { method: 'POST', body: JSON.stringify({ user_id: userId, role, site_id: siteId }) });
      roles.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const saveSettings = async (e: FormEvent, includeShift: boolean) => {
    e.preventDefault();
    if (!settings) return;
    setErr(null);
    try {
      const shifts = includeShift
        ? [
            ...(settings.shifts ?? []).filter((s: { code: string }) => s.code !== shiftCode),
            { code: shiftCode, label: shiftLabel, start_minute: Number(shiftStart), end_minute: Number(shiftEnd) },
          ]
        : undefined;
      const next = await api(`${M}/sites/${siteId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          pm_initial_state: pmInitial,
          ...(shifts ? { shifts } : {}),
          record_version: settings.version ?? settings.record_version,
        }),
      });
      setSettings(next);
    } catch (e) {
      setErr(e);
    }
  };

  const importLicense = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const doc = JSON.parse(licenseJson);
      setEnt(await api(`${M}/licenses`, { method: 'POST', body: JSON.stringify(doc) }));
      setLicenseJson('');
    } catch (e) {
      setErr(e);
    }
  };

  const createProcedure = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const p = await api<any>(`${M}/procedures`, { method: 'POST', body: JSON.stringify({ site_id: siteId, title: procTitle }) });
      const rev = await api<any>(`${M}/procedures/${p.id}/revisions`, {
        method: 'POST',
        body: JSON.stringify({
          safety_instructions: 'Wear PPE.',
          signature_required: signatureRequired,
          steps: signatureRequired
            ? [
                { key: 'gauge', label: 'Reading', type: 'numeric', unit: 'C', min: 0, max: 80, required: false },
                { key: 'follow', label: 'Follow-up', type: 'pass_fail', required: true, visible_when: { key: 'gauge', when: 'outside_limits' } },
              ]
            : [{ key: 'checked', label: 'Checked', type: 'pass_fail', required: true }],
        }),
      });
      await api(`${M}/procedure-revisions/${rev.id}/publish`, { method: 'POST', body: '{}' });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageHeader title="Settings" lede="Teams, roles, procedures, and site policy for this installation." />
      <ErrorBox err={err} />
      <div className="card">
        <h3>License</h3>
        <p>Status: {ent ? <Badge state={ent.status} /> : '…'}</p>
        <p className="muted">Installation {ent?.installation_id ?? '…'}</p>
        <p className="muted">Capabilities: {(ent?.capabilities ?? []).join(', ') || 'none'}</p>
        <form onSubmit={(e) => void importLicense(e)}>
          <label>Signed license JSON<textarea value={licenseJson} onChange={(e) => setLicenseJson(e.target.value)} rows={4} /></label>
          <button type="submit">Import license</button>
        </form>
      </div>
      <div className="card">
        <h3>Your permissions on this site</h3>
        <p className="muted">{perms.join(', ') || 'none'}</p>
      </div>
      <form className="card" onSubmit={(e) => void saveSettings(e, false)}>
        <h3>Site policy</h3>
        <label>PM initial state
          <select value={pmInitial} onChange={(e) => setPmInitial(e.target.value as typeof pmInitial)}>
            <option value="ready">Ready</option>
            <option value="pending_approval">Pending approval</option>
          </select>
        </label>
        <h4>Shift window</h4>
        <p className="muted">Used by the work-order planning board. Times are minutes from midnight in the site timezone.</p>
        <div className="row">
          <label>Code<input value={shiftCode} onChange={(e) => setShiftCode(e.target.value)} pattern="[a-z0-9_]+" required /></label>
          <label>Label<input value={shiftLabel} onChange={(e) => setShiftLabel(e.target.value)} required /></label>
          <label>Start minute<input type="number" min={0} max={1439} value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} required /></label>
          <label>End minute<input type="number" min={0} max={1439} value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} required /></label>
        </div>
        <ul>{(settings?.shifts ?? []).map((s: { code: string; label: string; start_minute: number; end_minute: number }) => <li key={s.code}>{s.label} ({s.code}) {s.start_minute}–{s.end_minute}</li>)}</ul>
        <div className="row">
          <button type="submit">Save site settings</button>
          <button type="button" className="secondary" onClick={(e) => void saveSettings(e, true)}>Save shift</button>
        </div>
      </form>
      <form className="card" onSubmit={(e) => void createTeam(e)}>
        <h3>Teams</h3>
        <label>Name<input value={teamName} onChange={(e) => setTeamName(e.target.value)} required /></label>
        <button type="submit">Create team</button>
        <Table>
          <thead><tr><th>Name</th><th>Members</th></tr></thead>
          <tbody>
            {teams.items.map((t) => <tr key={t.id}><td>{t.name}</td><td>{(t.member_ids ?? t.members ?? []).length}</td></tr>)}
            {!teams.items.length && emptyRow(2, teams.loading)}
          </tbody>
        </Table>
      </form>
      <form className="card" onSubmit={(e) => void grant(e)}>
        <h3>Role grants</h3>
        <label>User id<input value={userId} onChange={(e) => setUserId(e.target.value)} required /></label>
        <label>Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {['reporter', 'technician', 'supervisor', 'maintenance_manager', 'asset_administrator', 'viewer', 'maintenance_admin'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit">Grant</button>
        <Table>
          <thead><tr><th>User</th><th>Role</th><th>Site</th></tr></thead>
          <tbody>
            {roles.items.map((r) => <tr key={r.id}><td>{r.user_id}</td><td>{r.role}</td><td>{r.site_id ?? 'tenant'}</td></tr>)}
            {!roles.items.length && emptyRow(3, roles.loading)}
          </tbody>
        </Table>
      </form>
      <form className="card" onSubmit={(e) => void createProcedure(e)}>
        <h3>Publish a simple procedure</h3>
        <label>Title<input value={procTitle} onChange={(e) => setProcTitle(e.target.value)} required /></label>
        <label className="check"><input type="checkbox" checked={signatureRequired} onChange={(e) => setSignatureRequired(e.target.checked)} /> Require a completion signature and a follow-up when the reading is outside limits</label>
        <button type="submit">Create + publish</button>
      </form>
    </>
  );
}
