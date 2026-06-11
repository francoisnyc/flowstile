import { describe, it, expect } from 'vitest';
import {
  deriveMilestoneStates,
  type MilestoneTaskInput,
  type MilestoneState,
} from '../../src/common/milestones.js';
import type { CaseStatus } from '../../src/common/cases.js';

// Loan-shaped plan used by every fixture: REVIEW → CREDIT (often automated) →
// UNDERWRITE → DECIDE.
const PLAN = [
  { code: 'REVIEW', name: 'Application Review' },
  { code: 'CREDIT', name: 'Credit Assessment' },
  { code: 'UNDERWRITE', name: 'Underwriting' },
  { code: 'DECIDE', name: 'Final Decision' },
];

type S = MilestoneTaskInput['status'];
const t = (milestoneCode: string | null, status: S): MilestoneTaskInput => ({
  milestoneCode,
  status,
});

// The behavioral spec, as a table. Each row: a case history → the four
// expected states in plan order. Argue with this table, not the code.
const TABLE: Array<{
  name: string;
  tasks: MilestoneTaskInput[];
  caseStatus: CaseStatus;
  expected: [MilestoneState, MilestoneState, MilestoneState, MilestoneState];
}> = [
  {
    name: 'fresh case, no tasks yet → all pending',
    tasks: [],
    caseStatus: 'pending',
    expected: ['pending', 'pending', 'pending', 'pending'],
  },
  {
    name: 'first task open → first phase active, rest pending',
    tasks: [t('REVIEW', 'created')],
    caseStatus: 'in_progress',
    expected: ['active', 'pending', 'pending', 'pending'],
  },
  {
    name: 'claimed counts as open',
    tasks: [t('REVIEW', 'claimed')],
    caseStatus: 'in_progress',
    expected: ['active', 'pending', 'pending', 'pending'],
  },
  {
    name: 'automated phase jumps: open task two phases ahead achieves the gap',
    tasks: [t('REVIEW', 'completed'), t('UNDERWRITE', 'created')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'achieved', 'active', 'pending'],
  },
  {
    name: 'parallel open tasks in one phase → single active, no flicker',
    tasks: [t('REVIEW', 'completed'), t('UNDERWRITE', 'created'), t('UNDERWRITE', 'claimed')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'achieved', 'active', 'pending'],
  },
  {
    name: 'open tasks spanning two phases → both active, earlier phases achieved',
    tasks: [t('CREDIT', 'created'), t('UNDERWRITE', 'created')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'active', 'active', 'pending'],
  },
  {
    name: 'rework regresses the bar: review reopens after underwriting started',
    tasks: [
      t('REVIEW', 'completed'),
      t('UNDERWRITE', 'completed'),
      t('REVIEW', 'created'), // sent back
    ],
    caseStatus: 'in_progress',
    expected: ['active', 'pending', 'pending', 'pending'],
  },
  {
    name: 'repeated instances under one phase stay one phase',
    tasks: [t('REVIEW', 'completed'), t('REVIEW', 'completed'), t('REVIEW', 'created')],
    caseStatus: 'in_progress',
    expected: ['active', 'pending', 'pending', 'pending'],
  },
  {
    name: 'live case, no open phased tasks → high-water mark achieved, rest pending',
    tasks: [t('REVIEW', 'completed')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'pending', 'pending', 'pending'],
  },
  {
    name: 'unphased (exception) tasks never affect states',
    tasks: [t('REVIEW', 'completed'), t(null, 'created'), t(null, 'completed')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'pending', 'pending', 'pending'],
  },
  {
    name: 'stale milestone code after a plan edit degrades to unphased',
    tasks: [t('REMOVED_PHASE', 'created'), t('REVIEW', 'completed')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'pending', 'pending', 'pending'],
  },
  {
    name: 'cancelled tasks neither open nor achieve',
    tasks: [t('REVIEW', 'completed'), t('UNDERWRITE', 'cancelled')],
    caseStatus: 'in_progress',
    expected: ['achieved', 'pending', 'pending', 'pending'],
  },
  {
    name: 'happy path complete → all achieved, nothing skipped',
    tasks: [
      t('REVIEW', 'completed'),
      t('UNDERWRITE', 'completed'),
      t('DECIDE', 'completed'),
    ],
    caseStatus: 'completed',
    expected: ['achieved', 'achieved', 'achieved', 'achieved'],
  },
  {
    name: 'early rejection → later phases skipped, never eternally pending',
    tasks: [t('REVIEW', 'completed')],
    caseStatus: 'completed',
    expected: ['achieved', 'skipped', 'skipped', 'skipped'],
  },
  {
    name: 'cancelled case → progress kept, remainder skipped',
    tasks: [t('REVIEW', 'completed'), t('UNDERWRITE', 'cancelled')],
    caseStatus: 'cancelled',
    expected: ['achieved', 'skipped', 'skipped', 'skipped'],
  },
  {
    name: 'closed case with zero phased tasks → everything skipped',
    tasks: [t(null, 'cancelled')],
    caseStatus: 'cancelled',
    expected: ['skipped', 'skipped', 'skipped', 'skipped'],
  },
];

describe('deriveMilestoneStates', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const result = deriveMilestoneStates(PLAN, row.tasks, row.caseStatus);
      expect(result.map((m) => m.state)).toEqual(row.expected);
    });
  }

  it('preserves plan order and carries code + name through', () => {
    const result = deriveMilestoneStates(PLAN, [], 'pending');
    expect(result.map((m) => m.code)).toEqual(['REVIEW', 'CREDIT', 'UNDERWRITE', 'DECIDE']);
    expect(result[0].name).toBe('Application Review');
  });

  it('returns empty for an empty plan', () => {
    expect(deriveMilestoneStates([], [t('REVIEW', 'created')], 'in_progress')).toEqual([]);
  });
});
