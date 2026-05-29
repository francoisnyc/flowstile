import { describe, it, expect } from 'vitest';
import {
  buildCompletedPayload,
  completedSignalName,
  cancelledSignalName,
} from '../../src/signals/outbox.js';

describe('outbox helpers', () => {
  it('builds completed signal names by task id', () => {
    expect(completedSignalName('abc')).toBe('flowstile:task:completed:abc');
  });

  it('builds cancelled signal names by task id', () => {
    expect(cancelledSignalName('abc')).toBe('flowstile:task:cancelled:abc');
  });

  it('builds a completed payload with assignee as completedBy', () => {
    const payload = buildCompletedPayload({
      submissionData: { DECISION: 'APPROVED' },
      completedAt: new Date('2026-05-29T10:00:00.000Z'),
      formDefinitionVersion: 3,
      assignee: { id: 'u1', email: 'a@example.com', displayName: 'Alice' },
    });

    expect(payload).toEqual({
      data: { DECISION: 'APPROVED' },
      completedBy: { id: 'u1', email: 'a@example.com', displayName: 'Alice' },
      completedAt: '2026-05-29T10:00:00.000Z',
      formVersion: 3,
    });
  });

  it('builds a completed payload with null completedBy when there is no assignee', () => {
    const payload = buildCompletedPayload({
      submissionData: {},
      completedAt: null,
      formDefinitionVersion: 1,
      assignee: null,
    });

    expect(payload.completedBy).toBeNull();
    expect(payload.completedAt).toBeNull();
  });
});
