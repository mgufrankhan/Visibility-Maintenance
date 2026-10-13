export interface Session {
  access_token: string;
  refresh_token: string;
  tenant: string;
}

export interface Me {
  user_id: string;
  tenant_id: string;
  display_name: string;
  roles: Array<{ role: string; site_id: string | null }>;
  sites: Array<{ site_id: string; permissions: string[] }>;
  maintenance_sites: string[];
}

export interface Site {
  id: string;
  code: string;
  name: string;
  timezone: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field_errors?: Record<string, string[]>,
    readonly correlation_id?: string,
  ) {
    super(message);
  }
}

const SESSION_KEY = 'vm.session';

export function loadSession(): Session | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  if (!session) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api<T>(path: string, init: RequestInit = {}, session = loadSession()): Promise<T> {
  const headers = new Headers(init.headers);
  if (session) headers.set('authorization', `Bearer ${session.access_token}`);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof ArrayBuffer) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  const body = await parseBody(res);
  if (res.status === 401 && session?.refresh_token) {
    const refreshed = await refresh(session);
    if (refreshed) return api<T>(path, init, refreshed);
  }
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? res.statusText, err.field_errors, err.correlation_id);
  }
  return body as T;
}

export async function login(tenant: string, email: string, password: string): Promise<Session> {
  const tokens = await api<{ access_token: string; refresh_token: string }>('/api/v1/identity/sessions', {
    method: 'POST',
    body: JSON.stringify({ tenant, email, password }),
  }, null);
  const session = { ...tokens, tenant };
  saveSession(session);
  return session;
}

async function refresh(session: Session): Promise<Session | null> {
  try {
    const tokens = await api<{ access_token: string; refresh_token: string }>('/api/v1/identity/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refresh_token }),
    }, null);
    const next = { ...session, ...tokens };
    saveSession(next);
    return next;
  } catch {
    saveSession(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  const session = loadSession();
  if (session) {
    await api('/api/v1/identity/sessions/revoke', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) }, session).catch(() => undefined);
  }
  saveSession(null);
}

export const M = '/api/v1/maintenance';
