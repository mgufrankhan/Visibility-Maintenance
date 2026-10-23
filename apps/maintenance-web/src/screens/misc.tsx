import { useEffect, useState, type FormEvent } from 'react';
import { M, api } from '../api.ts';
import { Badge, ErrorBox, Notice, PageHeader, Table, emptyRow, useList } from '../ui.tsx';

const OPEN_WORK = 'draft,pending_approval,ready,in_progress,on_hold,pending_review';

export function Overview({ siteId }: { siteId: string }) {
  const work = useList<any>(`${M}/work-orders?site_id=${siteId}&limit=50`);
  const critical = useList<any>(`${M}/work-orders?site_id=${siteId}&priority=critical&state=${OPEN_WORK}&limit=50`);
  const overdue = useList<any>(`${M}/work-orders?site_id=${siteId}&overdue=true&limit=50`);
  const pmDue = useList<any>(`${M}/work-orders?site_id=${siteId}&type=preventive&overdue=true&limit=50`);
  const queue = useList<any>(`${M}/work-orders?site_id=${siteId}&unassigned=true&limit=50`);
  const ready = useList<any>(`${M}/work-orders?site_id=${siteId}&state=ready&limit=50`);
  const openReqs = useList<any>(`${M}/requests?site_id=${siteId}&state=submitted,under_review&limit=50`);
  const plans = useList<any>(`${M}/plans?site_id=${siteId}&status=active`);
  const recentWork = work.items.slice(0, 5);
  const recentReqs = openReqs.items.slice(0, 5);
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
        <a className={`stat-card ${critical.items.length ? 'warn' : ''}`} href={`#/work?priority=critical&state=${OPEN_WORK}`}>
          <span className="stat-value">{critical.loading ? '…' : critical.items.length}</span>
          <div className="stat-label">Critical work</div>
        </a>
        <a className={`stat-card ${overdue.items.length ? 'warn' : ''}`} href="#/work?overdue=true">
          <span className="stat-value">{overdue.loading ? '…' : overdue.items.length}</span>
          <div className="stat-label">Overdue work</div>
        </a>
        <a className={`stat-card ${pmDue.items.length ? 'warn' : ''}`} href="#/work?type=preventive&overdue=true">
          <span className="stat-value">{pmDue.loading ? '…' : pmDue.items.length}</span>
          <div className="stat-label">PM due</div>
        </a>
        <a className="stat-card" href="#/work?unassigned=true">
          <span className="stat-value">{queue.loading ? '…' : queue.items.length}</span>
          <div className="stat-label">Team queue</div>
        </a>
        <a className="stat-card" href="#/requests?state=submitted,under_review">
          <span className="stat-value">{openReqs.loading ? '…' : openReqs.items.length}</span>
          <div className="stat-label">Open requests</div>
        </a>
        <a className={`stat-card ${ready.items.length ? 'ok' : ''}`} href="#/work?state=ready">
          <span className="stat-value">{ready.loading ? '…' : ready.items.length}</span>
          <div className="stat-label">Ready orders</div>
        </a>
        <a className="stat-card" href="#/pm?status=active">
          <span className="stat-value">{plans.loading ? '…' : plans.items.length}</span>
          <div className="stat-label">Active PM plans</div>
        </a>
      </div>
      <ErrorBox err={work.err ?? critical.err ?? overdue.err ?? pmDue.err ?? queue.err ?? ready.err ?? openReqs.err ?? plans.err} />
      <div className="split-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Open requests</h3>
          {recentReqs.length === 0 && !openReqs.loading && <p className="muted">No open requests.</p>}
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

export function Downtime({ siteId, query }: { siteId: string; query: string }) {
  const list = useList<any>(`${M}/downtime-events?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}&limit=100`);
  const eventId = new URLSearchParams(query).get('event');
  const [assetId, setAssetId] = useState('');
  const [event, setEvent] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!eventId) {
      setEvent(null);
      return;
    }
    let cancelled = false;
    api<any>(`${M}/downtime-events/${eventId}`)
      .then((row) => {
        if (!cancelled) setEvent(row);
      })
      .catch((error) => {
        if (!cancelled) setErr(error);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);
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
      {event && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Downtime event</h3>
          <p>{event.classification} · started {event.started_at} · restored {event.restored_at ?? 'open'}</p>
          {(event.work_orders ?? []).length === 0 && <p className="muted">No linked work order.</p>}
          <ul>
            {(event.work_orders ?? []).map((order: { work_order_id: string; display_number: string }) => (
              <li key={order.work_order_id}><a href={`#/work?open=${order.work_order_id}`}>WO-{order.display_number}</a></li>
            ))}
          </ul>
        </div>
      )}
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

const REPORT_METRICS = ['failure_count', 'mtbf', 'mttr', 'mtta', 'downtime', 'overdue_backlog', 'pm_compliance', 'repeat_faults', 'maintenance_cost'] as const;
type ReportMetric = (typeof REPORT_METRICS)[number];
const SOURCE_TYPES = ['failure_event', 'request', 'work_order', 'labor_entry', 'external_service_cost', 'stock_movement'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

function isReportMetric(value: string): value is ReportMetric {
  return (REPORT_METRICS as readonly string[]).includes(value);
}

function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

function sourceTarget(record: { type: string; id: string; work_order_id?: string | null }): { href: string; label: string } | null {
  if (!isSourceType(record.type)) return null;
  switch (record.type) {
    case 'failure_event':
      return { href: `#/downtime?event=${record.id}`, label: 'Downtime event' };
    case 'request':
      return { href: `#/requests?open=${record.id}`, label: 'Request' };
    case 'work_order':
      return { href: `#/work?open=${record.id}`, label: 'Work order' };
    case 'labor_entry':
      return record.work_order_id ? { href: `#/work?open=${record.work_order_id}&focus=${record.id}`, label: 'Labor entry' } : null;
    case 'external_service_cost':
      return record.work_order_id ? { href: `#/work?open=${record.work_order_id}&focus=${record.id}`, label: 'External service cost' } : null;
    case 'stock_movement':
      return record.work_order_id ? { href: `#/work?open=${record.work_order_id}&focus=${record.id}`, label: 'Stock movement' } : null;
    default: {
      const never: never = record.type;
      return never;
    }
  }
}

function drilldown(data: any): Array<{ key: string; href: string; label: string }> {
  const rows = new Map<string, { key: string; href: string; label: string }>();
  const add = (key: string, target: { href: string; label: string } | null, detail?: string) => {
    if (!target || rows.has(key)) return;
    rows.set(key, { key, href: target.href, label: detail ? `${target.label} · ${detail}` : target.label });
  };
  for (const record of data.source_records ?? []) add(`${record.type}:${record.id}`, sourceTarget(record));
  for (const item of data.items ?? []) {
    if (item.display_number && item.id) add(`work_order:${item.id}`, sourceTarget({ type: 'work_order', id: item.id }), `WO-${item.display_number} ${item.title ?? ''}`.trim());
    if (item.work_order_id) add(`work_order:${item.work_order_id}`, sourceTarget({ type: 'work_order', id: item.work_order_id }), item.key ?? 'PM occurrence');
    for (const id of item.failure_ids ?? []) add(`failure_event:${id}`, sourceTarget({ type: 'failure_event', id }));
    for (const id of item.event_ids ?? []) add(`failure_event:${id}`, sourceTarget({ type: 'failure_event', id }));
  }
  for (const item of data.exemption_items ?? []) {
    if (item.work_order_id) add(`work_order:${item.work_order_id}`, sourceTarget({ type: 'work_order', id: item.work_order_id }), 'approved exemption');
  }
  for (const row of data.open_requests ?? []) add(`request:${row.id}`, sourceTarget({ type: 'request', id: row.id }), row.state);
  for (const row of data.open_failures ?? []) add(`failure_event:${row.id}`, sourceTarget({ type: 'failure_event', id: row.id }), 'still open');
  for (const group of data.groups ?? []) {
    for (const id of group.failure_ids ?? []) add(`failure_event:${id}`, sourceTarget({ type: 'failure_event', id }), group.failure_code);
  }
  return [...rows.values()];
}

function summaryLines(metric: ReportMetric, data: any): string[] {
  switch (metric) {
    case 'failure_count':
      return [`Qualifying failures: ${data.value}.`];
    case 'mtbf':
      return [(data.items ?? []).some((item: { status: string }) => item.status === 'unavailable_no_exposure')
        ? 'MTBF is unavailable where operating hours are missing.'
        : 'MTBF uses operating hours divided by qualifying failures.'];
    case 'mttr':
      return [data.mttr_hours === null
        ? 'MTTR is unavailable because no qualifying failure was restored in the period.'
        : `MTTR ${data.mttr_hours} hours over ${data.restored} restored failures.`];
    case 'mtta':
      return [
        data.average_hours === null
          ? 'Average acknowledgment time is unavailable because no request was accepted in the period.'
          : `Average acknowledgment ${data.average_hours} hours.`,
        `Accepted ${data.accepted_count}. Rejected ${data.rejected_count}. Still open ${data.open_requests?.length ?? 0}.`,
      ];
    case 'downtime':
      return [data.note];
    case 'overdue_backlog':
      return [`${data.value} open orders are past due as of ${data.as_of}.`];
    case 'pm_compliance':
      return [
        data.compliance_pct === null ? 'Compliance is unavailable because nothing was eligible.' : `Compliance ${data.compliance_pct}%.`,
        data.note,
      ];
    case 'repeat_faults':
      return [`Window ${data.window_days} days. Repeat groups ${data.groups?.length ?? 0}. Failures with no code ${data.unknown_code}.`];
    case 'maintenance_cost':
      return [data.basis];
    default: {
      const never: never = metric;
      return [String(never)];
    }
  }
}

function coverageLine(coverage: Record<string, unknown>): string {
  return Object.entries(coverage)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, value]) => `${key.replaceAll('_', ' ')} ${value}`)
    .join(' · ');
}

function scopeAsset(data: { scope?: { asset_id?: string | null } }, profiles: Array<{ asset?: { id?: string; code?: string; name?: string } }>): string {
  const assetId = data.scope?.asset_id;
  if (!assetId) return 'every asset at this site';
  const asset = profiles.find((profile) => profile.asset?.id === assetId)?.asset;
  return asset?.code ? `${asset.code}${asset.name ? ` — ${asset.name}` : ''}` : assetId;
}

function money(rows: Array<{ currency: string; amount: number; issue_count?: number; return_count?: number }> | undefined): string {
  if (!rows?.length) return 'none';
  return rows.map((row) => {
    const counts = row.issue_count === undefined ? '' : ` (${row.issue_count} issued, ${row.return_count ?? 0} returned)`;
    return `${row.amount} ${row.currency}${counts}`;
  }).join(', ');
}

function ReportResult({ data, profiles }: { data: any; profiles: Array<{ asset?: { id?: string; code?: string; name?: string } }> }) {
  if (!isReportMetric(data.metric)) return null;
  const metric = data.metric;
  const sources = drilldown(data);
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{metric.replaceAll('_', ' ')}</h3>
      <p>Period {data.period?.from} to {data.period?.to} ({data.period?.site_timezone}).</p>
      <p>Scope {scopeAsset(data, profiles)}.</p>
      {summaryLines(metric, data).map((line) => <p key={line}>{line}</p>)}
      {metric === 'mtbf' && (
        <Table>
          <thead><tr><th>Asset</th><th>Status</th><th>MTBF hours</th><th>Failures</th></tr></thead>
          <tbody>
            {(data.items ?? []).map((item: { asset_id: string; asset_code: string; status: string; mtbf_hours: number | null; failures: number }) => (
              <tr key={item.asset_id}>
                <td>{item.asset_code}</td>
                <td>{item.status === 'unavailable_no_exposure' ? 'Unavailable — operating hours are missing' : item.status.replaceAll('_', ' ')}</td>
                <td>{item.mtbf_hours ?? '—'}</td>
                <td>{item.failures}</td>
              </tr>
            ))}
            {!data.items?.length && emptyRow(4, false, 'No assets in scope.')}
          </tbody>
        </Table>
      )}
      {metric === 'maintenance_cost' && (
        <p>Labor {money(data.labor)}. External services {money(data.external_services)}. Parts {money(data.parts)}.</p>
      )}
      {data.coverage && <p>Coverage {coverageLine(data.coverage)}.</p>}
      {(data.exclusions ?? []).map((item: { reason: string; count: number }) => (
        <p key={`${item.reason}:${item.count}`} className="muted">Excluded {item.count} · {item.reason}.</p>
      ))}
      <h4>Source records</h4>
      {sources.length === 0 && <p className="muted">No source records in this result.</p>}
      <ul>
        {sources.map((row) => <li key={row.key}><a href={row.href}>{row.label}</a></li>)}
      </ul>
    </div>
  );
}

export function Reports({ siteId }: { siteId: string }) {
  const teams = useList<any>(`${M}/teams?site_id=${siteId}`);
  const assets = useList<any>(`${M}/asset-profiles?site_id=${siteId}&limit=100`);
  const [metric, setMetric] = useState('failure_count');
  const [priority, setPriority] = useState('');
  const [teamId, setTeamId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = async () => {
    setErr(null);
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86400000);
    const params = new URLSearchParams({ site_id: siteId, from: from.toISOString(), to: to.toISOString() });
    if (metric === 'overdue_backlog' && priority) params.set('priority', priority);
    if (metric === 'overdue_backlog' && teamId) params.set('team_id', teamId);
    if (metric === 'overdue_backlog' && assetId) params.set('asset_id', assetId);
    try {
      setData(await api(`${M}/reports/${metric}?${params.toString()}`));
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
              {REPORT_METRICS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          {metric === 'overdue_backlog' && (
            <>
              <label>Priority
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">Any</option>
                  {['critical', 'high', 'normal', 'low'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>Team
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">Any</option>
                  {teams.items.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
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
            </>
          )}
          <button type="button" onClick={() => void run()}>Run report</button>
        </div>
      </div>
      <ErrorBox err={err} />
      {data && <ReportResult data={data} profiles={assets.items} />}
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
