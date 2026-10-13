import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  readonly kind: string;
}

/** Local filesystem object store for private installations (D18). */
export class FilesystemBlobStore implements BlobStore {
  readonly kind = 'filesystem';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    return path.join(this.root, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, file);
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
