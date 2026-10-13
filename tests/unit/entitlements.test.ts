import { describe, expect, it } from 'vitest';
import type { LicenseDocument } from '@vm/contracts';
import { evaluateEntitlement, generateSigningKeyPair, signLicense, verifyLicense } from '@vm/licensing';

const tenant = '11111111-1111-4111-8111-111111111111';
const base: LicenseDocument = {
  license_id: 'LIC-1',
  product: 'visibility-maintenance',
  tenant_id: tenant,
  installation_id: 'inst-1',
  features: ['core', 'connected_operations'],
  limits: { sites: 1, operational_users: 10, maintainable_assets: 20 },
  term: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-12-31T00:00:00Z' },
  grace_days: 30,
  policy_tag: 'proposed-default-pending-commercial-approval',
  issued_at: '2025-12-01T00:00:00Z',
  key_id: 'k1',
};
const usage = { sites: 1, operational_users: 3, maintainable_assets: 5 };
const at = (iso: string, lastSeen: string | null = null) =>
  evaluateEntitlement({ license: base, verificationError: null, now: new Date(iso), lastSeenAt: lastSeen ? new Date(lastSeen) : null, usage });

describe('license signature verification', () => {
  const keys = generateSigningKeyPair();
  const signed = signLicense(base, keys.privateKeyPem);

  it('accepts a valid signature for the expected tenant and installation', () => {
    const v = verifyLicense(signed, { k1: keys.publicKeyPem }, { tenantId: tenant, installationId: 'inst-1' });
    expect(v.ok).toBe(true);
  });

  it('rejects tampering, foreign installations and unknown keys', () => {
    const tampered = { ...signed, license: { ...signed.license, features: ['core', 'connected_operations', 'neo_assistance'] } };
    expect(verifyLicense(tampered, { k1: keys.publicKeyPem }, { tenantId: tenant, installationId: 'inst-1' })).toMatchObject({ ok: false, reason: 'License signature is invalid' });
    expect(verifyLicense(signed, { k1: keys.publicKeyPem }, { tenantId: tenant, installationId: 'inst-2' })).toMatchObject({ ok: false });
    expect(verifyLicense(signed, { other: keys.publicKeyPem }, { tenantId: tenant, installationId: 'inst-1' })).toMatchObject({ ok: false });
    const otherKeys = generateSigningKeyPair();
    expect(verifyLicense(signed, { k1: otherKeys.publicKeyPem }, { tenantId: tenant, installationId: 'inst-1' })).toMatchObject({ ok: false });
  });
});

describe('entitlement evaluation (ML-01..ML-05)', () => {
  it('grants core and connected capabilities during the term', () => {
    const v = at('2026-06-01T00:00:00Z');
    expect(v.status).toBe('valid');
    expect(v.capabilities).toEqual(expect.arrayContaining(['core.create_work', 'core.generate_pm', 'connected.create_requests', 'connected.ingest']));
    expect(v.capabilities).not.toContain('neo.assist');
  });

  it('keeps full function with a warning during the 30-day grace', () => {
    const v = at('2027-01-15T00:00:00Z');
    expect(v.status).toBe('grace');
    expect(v.capabilities).toContain('core.create_work');
    expect(v.warnings.join(' ')).toMatch(/grace ends/);
  });

  it('after grace keeps read, export, fault reporting and active completion but blocks new work and connector requests', () => {
    const v = at('2027-02-15T00:00:00Z');
    expect(v.status).toBe('expired');
    expect(v.capabilities).toEqual(expect.arrayContaining(['core.read', 'core.export', 'core.report_fault', 'core.complete_active_work', 'connected.ingest']));
    expect(v.capabilities).not.toContain('core.create_work');
    expect(v.capabilities).not.toContain('core.generate_pm');
    expect(v.capabilities).not.toContain('connected.create_requests');
  });

  it('treats a rolled-back clock as an anomaly and evaluates against the high-water mark', () => {
    const v = at('2026-06-01T00:00:00Z', '2027-03-01T00:00:00Z');
    expect(v.clock_anomaly).toBe(true);
    expect(v.status).toBe('expired');
  });

  it('marks missing and invalid licenses without granting new work', () => {
    const missing = evaluateEntitlement({ license: null, verificationError: null, now: new Date(), lastSeenAt: null, usage });
    expect(missing.status).toBe('missing');
    expect(missing.capabilities).toContain('core.read');
    expect(missing.capabilities).not.toContain('core.create_work');
    const invalid = evaluateEntitlement({ license: null, verificationError: 'bad', now: new Date(), lastSeenAt: null, usage });
    expect(invalid.status).toBe('invalid');
  });

  it('warns when usage approaches or exceeds a licensed limit', () => {
    const v = evaluateEntitlement({ license: base, verificationError: null, now: new Date('2026-06-01T00:00:00Z'), lastSeenAt: null, usage: { sites: 2, operational_users: 9, maintainable_assets: 5 } });
    expect(v.warnings.some((w) => w.includes('sites (2) exceeds'))).toBe(true);
    expect(v.warnings.some((w) => w.includes('operational_users is 9 of 10'))).toBe(true);
  });
});
