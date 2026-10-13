import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { M, api, loadSession, login, logout, type Me, type Session, type Site } from './api.ts';
import { clearQueue, listQueue, recordResult, type QueuedOperation } from './offline.ts';
import { Assets } from './screens/assets.tsx';
import { Connectors } from './screens/connectors.tsx';
import { Inspections } from './screens/inspections.tsx';
import { Downtime, Neo, Overview, Reports } from './screens/misc.tsx';
import { MyWork } from './screens/my-work.tsx';
import { Plans } from './screens/plans.tsx';
import { Requests } from './screens/requests.tsx';
import { Settings } from './screens/settings.tsx';
import { WorkOrders } from './screens/work.tsx';
import { ErrorBox } from './ui.tsx';

type Route =
  | 'overview'
  | 'requests'
  | 'work'
  | 'pm'
  | 'inspections'
  | 'assets'
  | 'connectors'
  | 'downtime'
  | 'reports'
  | 'settings'
  | 'neo'
  | 'my-work';

const ROUTES: Array<{ id: Route; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'requests', label: 'Requests' },
  { id: 'work', label: 'Work Orders' },
  { id: 'my-work', label: 'My Work' },
  { id: 'pm', label: 'Preventive Maintenance' },
  { id: 'inspections', label: 'Inspections' },
  { id: 'assets', label: 'Assets' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'downtime', label: 'Downtime' },
  { id: 'reports', label: 'Reports' },
  { id: 'neo', label: 'Neo' },
  { id: 'settings', label: 'Settings' },
];

function routeFromHash(): Route {
  const id = location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.some((r) => r.id === id) ? id : 'overview';
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onOnline = () => setOnline(navigator.onLine);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
    };
  }, []);

  const loadQueue = useCallback(async () => setQueue(await listQueue()), []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const [who, siteList] = await Promise.all([
          api<Me>(`${M}/me`),
          api<{ items?: Site[] } | Site[]>('/api/v1/identity/sites'),
        ]);
        if (cancelled) return;
        setMe(who);
        const list = Array.isArray(siteList) ? siteList : siteList.items ?? [];
        setSites(list);
        setSiteId((current) => current || who.maintenance_sites[0] || who.sites[0]?.site_id || list[0]?.id || '');
        await loadQueue();
      } catch (e) {
        if (!cancelled) setBootError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, loadQueue]);

  if (!session) return <Login onSignedIn={setSession} />;

  return (
    <div className="shell">
      <nav className="side" aria-label="Product">
        <h1>Visibility Maintenance</h1>
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id}`} aria-current={route === r.id ? 'page' : undefined}>{r.label}</a>
        ))}
      </nav>
      <main>
        <div className="top">
          <div>
            <strong>{me?.display_name ?? '…'}</strong>
            <div className="muted">{online ? 'Online' : 'Offline — cached work only'}</div>
          </div>
          <div className="row">
            <label>
              Site
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
                {sites.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
                {!sites.length && me?.sites.map((s) => <option key={s.site_id} value={s.site_id}>{s.site_id}</option>)}
              </select>
            </label>
            <button className="secondary" type="button" onClick={() => { void logout(); setSession(null); void clearQueue(); }}>Sign out</button>
          </div>
        </div>
        <ErrorBox err={bootError} />
        {queue.length > 0 && <QueueBanner items={queue} onFlush={() => flushQueue(loadQueue)} />}
        {siteId ? <Screen route={route} siteId={siteId} me={me} online={online} onQueued={loadQueue} /> : <p className="muted">No site is in scope for this account.</p>}
      </main>
    </div>
  );
}

function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [tenant, setTenant] = useState('acme');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      onSignedIn(await login(tenant, email, password));
    } catch (error) {
      setErr(error);
    }
  };
  return (
    <form className="card login" onSubmit={(e) => void submit(e)}>
      <h1>Visibility Maintenance</h1>
      <p className="muted">Sign in with your site credentials. Core work stays available if Neo or telemetry are offline.</p>
      <label>Tenant slug<input value={tenant} onChange={(e) => setTenant(e.target.value)} required autoComplete="organization" /></label>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
      <ErrorBox err={err} />
      <button type="submit">Sign in</button>
    </form>
  );
}

function QueueBanner({ items, onFlush }: { items: QueuedOperation[]; onFlush: () => void }) {
  const pending = items.filter((i) => i.status === 'pending').length;
  const conflicts = items.filter((i) => i.status !== 'pending');
  return (
    <div className="card" role="status">
      <strong>Offline queue:</strong> {pending} pending{conflicts.length ? `, ${conflicts.length} need review` : ''}.
      <button type="button" className="secondary" onClick={onFlush}>Retry sync</button>
      {conflicts.map((c) => <p key={c.client_op_id} className="err">{c.type} {c.record_id}: {c.server_error}</p>)}
    </div>
  );
}

async function flushQueue(reload: () => Promise<void>) {
  const items = (await listQueue()).filter((i) => i.status === 'pending');
  if (!items.length) return;
  try {
    const res = await api<{ results: Array<{ client_op_id: string; outcome: string; message?: string }> }>(`${M}/sync/operations`, {
      method: 'POST',
      body: JSON.stringify({
        operations: items.map(({ client_op_id, type, record_id, base_version, payload, queued_at }) => ({
          client_op_id,
          type,
          record_id,
          base_version,
          client_time: queued_at,
          payload,
        })),
      }),
    });
    for (const r of res.results) {
      await recordResult(r.client_op_id, r.outcome === 'applied' ? 'pending' : 'conflict', r.message);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const i of items) await recordResult(i.client_op_id, 'conflict', msg);
  }
  await reload();
}

function Screen({ route, siteId, me, online, onQueued }: { route: Route; siteId: string; me: Me | null; online: boolean; onQueued: () => Promise<void> }) {
  switch (route) {
    case 'overview':
      return <Overview siteId={siteId} />;
    case 'requests':
      return <Requests siteId={siteId} />;
    case 'work':
      return <WorkOrders siteId={siteId} />;
    case 'my-work':
      return <MyWork siteId={siteId} online={online} onQueued={onQueued} />;
    case 'pm':
      return <Plans siteId={siteId} />;
    case 'inspections':
      return <Inspections siteId={siteId} />;
    case 'assets':
      return <Assets siteId={siteId} />;
    case 'connectors':
      return <Connectors siteId={siteId} />;
    case 'downtime':
      return <Downtime siteId={siteId} />;
    case 'reports':
      return <Reports siteId={siteId} />;
    case 'neo':
      return <Neo siteId={siteId} />;
    case 'settings':
      return <Settings siteId={siteId} me={me} />;
    default: {
      const _never: never = route;
      return _never;
    }
  }
}
