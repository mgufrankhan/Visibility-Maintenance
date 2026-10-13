import type { AssetDto, PlatformMeta, SiteDto, TokenResponse } from '@vm/contracts';

/** Registry could not be reached or failed; callers fall back to identity snapshots (MA-08). */
export class RegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

export class RegistryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Registry request failed with ${status}`);
    this.name = 'RegistryRequestError';
  }
}

export interface DirectoryEntry {
  id: string;
  display_name: string;
  kind: 'human' | 'service';
}

export interface ExternalRef {
  id: string;
  asset_id: string;
  provider: string;
  provider_instance: string;
  external_id: string;
  status: string;
  site_id: string;
}

export interface RegistryClient {
  /** Active registry mapping for an external identity, or null when absent or not visible. */
  lookupExternalRef(token: string, ref: { provider: string; provider_instance: string; external_id: string }): Promise<ExternalRef | null>;
  getAsset(token: string, id: string): Promise<(AssetDto & { resolved_from_alias?: string | null }) | null>;
  getAssets(token: string, ids: string[]): Promise<AssetDto[]>;
  listAssets(token: string, q: { site_id?: string; q?: string; lifecycle?: string; cursor?: string; limit?: number }): Promise<{ items: AssetDto[]; next_cursor: string | null }>;
  changes(token: string, afterSeq: string, limit?: number): Promise<{ items: AssetDto[]; last_seq: string }>;
  resolveQr(token: string, qrToken: string): Promise<AssetDto | null>;
  getSite(token: string, siteId: string): Promise<SiteDto | null>;
  listSites(token: string): Promise<SiteDto[]>;
  directory(token: string, siteId: string): Promise<DirectoryEntry[]>;
  meta(): Promise<PlatformMeta>;
}

export interface HttpRegistryClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpRegistryClient implements RegistryClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpRegistryClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(token: string, path: string, allow404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RegistryUnavailableError(`Registry unreachable: ${(err as Error).message}`);
    }
    if (res.status === 404 && allow404) return null;
    if (res.status >= 500) throw new RegistryUnavailableError(`Registry returned ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new RegistryRequestError(res.status, body);
    return body as T;
  }

  async getAsset(token: string, id: string) {
    return this.request<AssetDto & { resolved_from_alias?: string | null }>(token, `/api/v1/assets/${encodeURIComponent(id)}`, true);
  }

  async getAssets(token: string, ids: string[]): Promise<AssetDto[]> {
    if (ids.length === 0) return [];
    const out: AssetDto[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await this.request<{ items: AssetDto[] }>(token, `/api/v1/assets?limit=200&ids=${chunk.join(',')}`);
      out.push(...(r?.items ?? []));
    }
    return out;
  }

  async listAssets(token: string, q: { site_id?: string; q?: string; lifecycle?: string; cursor?: string; limit?: number }) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    return (await this.request<{ items: AssetDto[]; next_cursor: string | null }>(token, `/api/v1/assets?${params}`))!;
  }

  async changes(token: string, afterSeq: string, limit = 200) {
    return (await this.request<{ items: AssetDto[]; last_seq: string }>(token, `/api/v1/assets/changes?after_seq=${afterSeq}&limit=${limit}`))!;
  }

  async resolveQr(token: string, qrToken: string) {
    return this.request<AssetDto>(token, `/api/v1/assets/resolve-qr/${encodeURIComponent(qrToken)}`, true);
  }

  async getSite(token: string, siteId: string) {
    return this.request<SiteDto>(token, `/api/v1/identity/sites/${encodeURIComponent(siteId)}`, true);
  }

  async listSites(token: string) {
    return (await this.request<{ items: SiteDto[] }>(token, `/api/v1/identity/sites`))!.items;
  }

  async lookupExternalRef(token: string, ref: { provider: string; provider_instance: string; external_id: string }) {
    const params = new URLSearchParams(ref);
    return this.request<ExternalRef>(token, `/api/v1/assets/external-refs/lookup?${params}`, true);
  }

  async directory(token: string, siteId: string) {
    return (await this.request<{ items: DirectoryEntry[] }>(token, `/api/v1/identity/directory?site_id=${encodeURIComponent(siteId)}`))!.items;
  }

  async meta() {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/v1/meta`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new RegistryUnavailableError(`Registry unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new RegistryUnavailableError(`Registry meta returned ${res.status}`);
    return (await res.json()) as PlatformMeta;
  }
}

/** Client-credentials token cache for background work run under a narrow service identity. */
export class ServiceTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly opts: { baseUrl: string; clientId: string; clientSecret: string; fetchImpl?: typeof fetch },
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) return this.cached.token;
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl.replace(/\/$/, '')}/api/v1/identity/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.opts.clientId, client_secret: this.opts.clientSecret }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new RegistryUnavailableError(`Identity service unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new RegistryRequestError(res.status, await res.json().catch(() => null));
    const body = (await res.json()) as TokenResponse;
    this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
