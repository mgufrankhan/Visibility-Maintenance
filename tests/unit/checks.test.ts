import { describe, expect, it } from 'vitest';
import { checkGraphError } from '@vm/contracts';
import { isStepVisible, procedureSnapshotHash } from '@vm/core';

const gauge = { key: 'gauge', label: 'Gauge', type: 'numeric' as const, unit: 'C', min: 0, max: 80 };
const follow = {
  key: 'follow',
  label: 'Follow up',
  type: 'pass_fail' as const,
  visible_when: { key: 'gauge', when: 'outside_limits' as const },
};

describe('conditional checks', () => {
  it('rejects a rule that points forward or at a check that cannot produce it', () => {
    expect(checkGraphError([{ key: 'follow', type: 'pass_fail', visible_when: { key: 'later', when: 'failed' } }, { key: 'later', type: 'pass_fail', visible_when: null }])).toMatch(/earlier/);
    expect(checkGraphError([
      { key: 'ok', type: 'pass_fail', visible_when: null },
      { key: 'later', type: 'pass_fail', visible_when: { key: 'ok', when: 'outside_limits' } },
    ])).toMatch(/numeric/);
    expect(checkGraphError([
      { key: 'gauge', type: 'numeric', visible_when: null },
      { key: 'follow', type: 'pass_fail', visible_when: { key: 'gauge', when: 'outside_limits' } },
    ])).toBeNull();
  });

  it('hides a later step until the earlier answer makes it visible', () => {
    expect(isStepVisible(follow, new Map())).toBe(false);
    expect(isStepVisible(follow, new Map([['gauge', { passed: true }]]))).toBe(false);
    expect(isStepVisible(follow, new Map([['gauge', { passed: false }]]))).toBe(true);
    expect(isStepVisible(follow, new Map([['gauge', { passed: null, note: 'not_applicable' }]]))).toBe(false);
  });

  it('keeps the procedure signature hash stable for the same snapshot', () => {
    const snapshot = { procedure_revision_id: 'rev-1', revision_no: 2, signature_required: true, safety_instructions: 'Lock out', steps: [gauge, follow] };
    const hash = procedureSnapshotHash(snapshot);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(procedureSnapshotHash(snapshot)).toBe(hash);
    expect(procedureSnapshotHash({ ...snapshot, steps: [gauge] })).not.toBe(hash);
  });
});
