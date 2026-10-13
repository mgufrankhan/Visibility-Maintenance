import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalJson, licenseDocument, type LicenseDocument, type SignedLicense } from '@vm/contracts';

export { canonicalJson };

export function generateSigningKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Signing happens on the vendor side; private keys are never shipped in a deployment. */
export function signLicense(license: LicenseDocument, privateKeyPem: string): SignedLicense {
  const parsed = licenseDocument.parse(license);
  const signature = sign(null, Buffer.from(canonicalJson(parsed)), createPrivateKey(privateKeyPem));
  return { license: parsed, signature: signature.toString('base64') };
}

export type VerificationResult = { ok: true; license: LicenseDocument } | { ok: false; reason: string };

export function verifyLicense(
  input: unknown,
  publicKeys: Readonly<Record<string, string>>,
  expected: { tenantId: string; installationId: string },
): VerificationResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'License document is not an object' };
  const { license, signature } = input as Partial<SignedLicense>;
  const parsed = licenseDocument.safeParse(license);
  if (!parsed.success) return { ok: false, reason: 'License document is malformed' };
  if (typeof signature !== 'string') return { ok: false, reason: 'License signature missing' };
  const keyPem = publicKeys[parsed.data.key_id];
  if (!keyPem) return { ok: false, reason: `Unknown license signing key ${parsed.data.key_id}` };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(parsed.data)), createPublicKey(keyPem), Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'License signature is invalid' };
  if (parsed.data.tenant_id !== expected.tenantId) return { ok: false, reason: 'License is issued for a different tenant' };
  if (parsed.data.installation_id !== expected.installationId) {
    return { ok: false, reason: 'License is issued for a different installation' };
  }
  return { ok: true, license: parsed.data };
}
