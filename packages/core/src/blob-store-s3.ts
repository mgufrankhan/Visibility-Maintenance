import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { FilesystemBlobStore, type BlobStore } from './blob-store.ts';

export interface S3BlobStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (MinIO / many private S3-compatible stores). Default true. */
  forcePathStyle?: boolean;
}

/**
 * Optional S3-compatible object store (D18). Uses SigV4 over HTTPS/HTTP without
 * embedding provider endpoints — callers supply endpoint and credentials via env.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3';
  private readonly endpoint: URL;
  private readonly forcePathStyle: boolean;

  constructor(private readonly opts: S3BlobStoreOptions) {
    this.endpoint = new URL(opts.endpoint);
    this.forcePathStyle = opts.forcePathStyle ?? true;
  }

  private objectUrl(key: string): URL {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    if (this.forcePathStyle) {
      return new URL(`${this.endpoint.origin}/${this.opts.bucket}/${key}`);
    }
    const host = `${this.opts.bucket}.${this.endpoint.host}`;
    return new URL(`${this.endpoint.protocol}//${host}/${key}`);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const url = this.objectUrl(key);
    const res = await this.signed('PUT', url, bytes, 'application/octet-stream');
    if (!res.ok) throw new Error(`S3 put failed (${res.status}): ${await res.text()}`);
  }

  async get(key: string): Promise<Readable> {
    const url = this.objectUrl(key);
    const res = await this.signed('GET', url);
    if (res.status === 404) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    if (!res.ok) throw new Error(`S3 get failed (${res.status}): ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return Readable.from(buf);
  }

  async exists(key: string): Promise<boolean> {
    const url = this.objectUrl(key);
    const res = await this.signed('HEAD', url);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`S3 head failed (${res.status})`);
    return true;
  }

  async delete(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const res = await this.signed('DELETE', url);
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed (${res.status}): ${await res.text()}`);
  }

  private async signed(method: string, url: URL, body?: Buffer, contentType?: string): Promise<Response> {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body ?? '').digest('hex');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;
    if (body) headers['content-length'] = String(body.length);

    const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => {
      const value = headers[h];
      if (value === undefined) throw new Error(`Missing signed header ${h}`);
      return `${h}:${value.trim()}\n`;
    }).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signingKey = this.signingKey(dateStamp);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(url, {
      method,
      headers,
      body: body && method !== 'GET' && method !== 'HEAD' ? new Uint8Array(body) : undefined,
    });
  }

  private signingKey(dateStamp: string): Buffer {
    const kDate = createHmac('sha256', `AWS4${this.opts.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(this.opts.region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    return createHmac('sha256', kService).update('aws4_request').digest();
  }
}

/** Select filesystem (default) or S3-compatible storage from environment (D18). */
export function blobStoreFromEnv(blobRoot: string): BlobStore {
  const driver = (process.env.BLOB_STORE ?? 'filesystem').toLowerCase();
  if (driver === 'filesystem') return new FilesystemBlobStore(blobRoot);
  if (driver === 's3') {
    const endpoint = process.env.S3_ENDPOINT;
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION ?? 'us-east-1';
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('BLOB_STORE=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
    }
    return new S3BlobStore({
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  throw new Error(`Unknown BLOB_STORE driver: ${driver}`);
}
