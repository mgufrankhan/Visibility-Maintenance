import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * Loads the installation's ES256 token signing key, creating it on first start.
 * The file lives on the persistent identity volume and is included in backups.
 */
export async function loadOrCreateSigningKey(file: string): Promise<SigningKey> {
  let privateJwk: JWK;
  try {
    privateJwk = JSON.parse(await readFile(file, 'utf8')) as JWK;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    privateJwk = await exportJWK(privateKey);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(privateJwk), { mode: 0o600 });
  }
  const { d: _d, ...pub } = privateJwk;
  const kid = createHash('sha256').update(`${pub.x}.${pub.y}`).digest('base64url').slice(0, 16);
  const privateKey = (await importJWK({ ...privateJwk, alg: 'ES256' }, 'ES256')) as CryptoKey;
  return { kid, privateKey, publicJwk: { ...pub, kid, alg: 'ES256', use: 'sig' } };
}
