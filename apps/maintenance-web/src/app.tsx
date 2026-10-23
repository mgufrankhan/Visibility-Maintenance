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
import { Parts } from './screens/parts.tsx';
import { WorkOrders } from './screens/work.tsx';
import { BrandLogo, ConnectionStatus, EmptyState, ErrorBox } from './ui.tsx';

type Route =
  | 'overview'
  | 'requests'
  | 'work'
  | 'pm'
  | 'inspections'
  | 'assets'
  | 'parts'
  | 'connectors'
  | 'downtime'
  | 'reports'
  | 'settings'
  | 'neo'
  | 'my-work';

const NAV_GROUPS: Array<{ label: string; items: Array<{ id: Route; label: string }> }> = [
  {
    label: 'Work',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'my-work', label: 'My Work' },
      { id: 'requests', label: 'Requests' },
      { id: 'work', label: 'Work Orders' },
      { id: 'pm', label: 'PM Plans' },
      { id: 'inspections', label: 'Inspections' },
    ],
  },
  {
    label: 'Assets & stock',
    items: [
      { id: 'assets', label: 'Assets' },
      { id: 'parts', label: 'Parts' },
      { id: 'downtime', label: 'Downtime' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { id: 'reports', label: 'Reports' },
      { id: 'neo', label: 'Neo' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'connectors', label: 'Connectors' },
      { id: 'settings', label: 'Settings' },
    ],
  },
];

const ALL_ROUTES = NAV_GROUPS.flatMap((g) => g.items);

const SITE_KEY = 'vm.siteId';

function locationFromHash(): { route: Route; query: string } {
  const raw = location.hash.replace(/^#\/?/, '');
  const splitAt = raw.indexOf('?');
  const id = (splitAt === -1 ? raw : raw.slice(0, splitAt)) as Route;
  return {
    route: ALL_ROUTES.some((r) => r.id === id) ? id : 'overview',
    query: splitAt === -1 ? '' : raw.slice(splitAt + 1),
  };
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState(() => sessionStorage.getItem(SITE_KEY) ?? '');
  const [location, setLocation] = useState(locationFromHash);
  const route = location.route;
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);

  useEffect(() => {
    const onHash = () => setLocation(locationFromHash());
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

  const chooseSite = (id: string) => {
    setSiteId(id);
    if (id) sessionStorage.setItem(SITE_KEY, id);
    else sessionStorage.removeItem(SITE_KEY);
  };

  const loadQueue = useCallback(async () => setQueue(await listQueue()), []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      setBootError(null);
      let list: Site[] = [];
      const saved = sessionStorage.getItem(SITE_KEY) ?? '';
      try {
        const siteList = await api<{ items?: Site[] } | Site[]>('/api/v1/identity/sites');
        if (cancelled) return;
        list = Array.isArray(siteList) ? siteList : siteList.items ?? [];
        setSites(list);
      } catch (e) {
        if (!cancelled) setBootError(e);
      }
      try {
        const who = await api<Me>(`${M}/me`);
        if (cancelled) return;
        setMe(who);
        const known = (id: string) => list.some((s) => s.id === id) || who.sites.some((s) => s.site_id === id);
        const preferred =
          (saved && known(saved) ? saved : '')
          || who.maintenance_sites[0]
          || who.sites[0]?.site_id
          || list[0]?.id
          || '';
        chooseSite(preferred);
        await loadQueue();
      } catch (e) {
        if (cancelled) return;
        setBootError(e);
        const fallback = (saved && list.some((s) => s.id === saved) ? saved : '') || list[0]?.id || '';
        chooseSite(fallback);
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
        <BrandLogo variant="nav" />
        <div className="nav-groups">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((r) => (
                <a key={r.id} href={`#/${r.id}`} aria-current={route === r.id ? 'page' : undefined}>{r.label}</a>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <main>
        <div className="top">
          <div className="top-identity">
            <strong>{me?.display_name ?? '…'}</strong>
            <ConnectionStatus online={online} />
          </div>
          <div className="top-actions">
            <label>
              Site
              <select value={siteId} onChange={(e) => chooseSite(e.target.value)} aria-label="Site">
                {!siteId && <option value="">Select a site…</option>}
                {sites.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
                {!sites.length && me?.sites.map((s) => <option key={s.site_id} value={s.site_id}>{s.site_id}</option>)}
              </select>
            </label>
            <button
              className="secondary"
              type="button"
              onClick={() => { void logout(); setSession(null); setMe(null); void clearQueue(); sessionStorage.removeItem(SITE_KEY); }}
            >
              Sign out
            </button>
          </div>
        </div>
        <div className="content">
          <ErrorBox err={bootError} />
          {queue.length > 0 && <QueueBanner items={queue} onFlush={() => flushQueue(loadQueue)} />}
          {siteId ? (
            <Screen route={route} query={location.query} siteId={siteId} me={me} online={online} onQueued={loadQueue} timezone={sites.find((s) => s.id === siteId)?.timezone ?? 'UTC'} />
          ) : (
            <div className="card">
              <EmptyState
                title="No site in scope"
                detail="This account has no site membership yet, or the maintenance API is unavailable. Ask an administrator to grant a site, then refresh."
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [tenant, setTenant] = useState('cew');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      onSignedIn(await login(tenant, email, password));
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <form className="card login" onSubmit={(e) => void submit(e)}>
        <BrandLogo variant="full" />
        <p className="muted login-lead">
          Sign in with your site credentials. Core work stays available if Neo or telemetry are offline.
        </p>
        <label>Tenant slug<input value={tenant} onChange={(e) => setTenant(e.target.value)} required autoComplete="organization" /></label>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        <ErrorBox err={err} />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function QueueBanner({ items, onFlush }: { items: QueuedOperation[]; onFlush: () => void }) {
  const pending = items.filter((i) => i.status === 'pending').length;
  const conflicts = items.filter((i) => i.status !== 'pending');
  return (
    <div className={`card queue-banner ${conflicts.length ? 'alert-warn' : ''}`} role="status">
      <p className="queue-copy">
        <strong>Offline queue</strong>
        {' — '}
        {pending} pending{conflicts.length ? `, ${conflicts.length} need review` : ''}.
        {conflicts.map((c) => (
          <span key={c.client_op_id} className="err"> {c.type} {c.record_id}: {c.server_error}</span>
        ))}
      </p>
      <button type="button" className="secondary" onClick={onFlush}>Retry sync</button>
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

function Screen({ route, query, siteId, me, online, onQueued, timezone }: { route: Route; query: string; siteId: string; me: Me | null; online: boolean; onQueued: () => Promise<void>; timezone: string }) {
  switch (route) {
    case 'overview':
      return <Overview siteId={siteId} />;
    case 'requests':
      return <Requests siteId={siteId} query={query} />;
    case 'work':
      return <WorkOrders siteId={siteId} timezone={timezone} query={query} />;
    case 'my-work':
      return <MyWork siteId={siteId} online={online} onQueued={onQueued} />;
    case 'pm':
      return <Plans siteId={siteId} query={query} />;
    case 'inspections':
      return <Inspections siteId={siteId} />;
    case 'assets':
      return <Assets siteId={siteId} />;
    case 'parts':
      return <Parts siteId={siteId} />;
    case 'connectors':
      return <Connectors siteId={siteId} />;
    case 'downtime':
      return <Downtime siteId={siteId} query={query} />;
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
