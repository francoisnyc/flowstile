import { describe, it, expect } from 'vitest';
import {
  normalizeMapping,
  projectContext,
  buildPersistPatch,
} from '../src/mapping.js';

describe('normalizeMapping', () => {
  it('maps array entries to same-name pairs', () => {
    expect(normalizeMapping(['a', 'b'])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  it('keeps object entries as source→dest pairs', () => {
    expect(normalizeMapping({ DECISION: 'decision', RATIONALE: 'rationale' })).toEqual([
      ['DECISION', 'decision'],
      ['RATIONALE', 'rationale'],
    ]);
  });
});

describe('projectContext (contextFrom)', () => {
  const entity = { creditScore: 720, riskTier: 'LOW', amount: 20_000 };

  it('projects the named keys (array form)', () => {
    expect(projectContext(entity, ['creditScore', 'riskTier'])).toEqual({
      creditScore: 720,
      riskTier: 'LOW',
    });
  });

  it('renames on projection (object form)', () => {
    expect(projectContext(entity, { creditScore: 'CREDIT_SCORE', riskTier: 'RISK_TIER' })).toEqual({
      CREDIT_SCORE: 720,
      RISK_TIER: 'LOW',
    });
  });

  it('skips missing source keys', () => {
    expect(projectContext(entity, ['creditScore', 'missing'])).toEqual({ creditScore: 720 });
  });

  it('projects nothing when the entity is null/undefined (first task)', () => {
    expect(projectContext(null, ['creditScore'])).toEqual({});
    expect(projectContext(undefined, ['creditScore'])).toEqual({});
  });

  it('preserves falsy values (0, false, empty string)', () => {
    expect(projectContext({ a: 0, b: false, c: '' }, ['a', 'b', 'c'])).toEqual({
      a: 0,
      b: false,
      c: '',
    });
  });
});

describe('buildPersistPatch (persist)', () => {
  const submission = { DECISION: 'APPROVE', RATIONALE: 'ok', INTERNAL: 'x' };

  it('builds add ops for the allowlisted fields (array form, same key)', () => {
    expect(buildPersistPatch(submission, ['DECISION'])).toEqual([
      { op: 'add', path: '/DECISION', value: 'APPROVE' },
    ]);
  });

  it('renames on persist (object form)', () => {
    expect(
      buildPersistPatch(submission, { DECISION: 'underwritingDecision', RATIONALE: 'underwritingRationale' }),
    ).toEqual([
      { op: 'add', path: '/underwritingDecision', value: 'APPROVE' },
      { op: 'add', path: '/underwritingRationale', value: 'ok' },
    ]);
  });

  it('skips fields absent from the submission (allowlist, not merge-all)', () => {
    expect(buildPersistPatch(submission, ['DECISION', 'MISSING'])).toEqual([
      { op: 'add', path: '/DECISION', value: 'APPROVE' },
    ]);
    // INTERNAL is in the submission but not the allowlist — never persisted
    expect(buildPersistPatch(submission, ['DECISION']).some((o) => o.path.includes('INTERNAL'))).toBe(false);
  });

  it('escapes JSON Pointer special characters in the destination key', () => {
    expect(buildPersistPatch({ X: 1 }, { X: 'a/b~c' })).toEqual([
      { op: 'add', path: '/a~1b~0c', value: 1 },
    ]);
  });

  it('preserves falsy submitted values', () => {
    expect(buildPersistPatch({ N: 0, B: false }, ['N', 'B'])).toEqual([
      { op: 'add', path: '/N', value: 0 },
      { op: 'add', path: '/B', value: false },
    ]);
  });
});
