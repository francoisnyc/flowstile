import { describe, it, expect } from 'vitest';
import { TaskStatus } from '../../src/common/enums.js';
import { TaskStateMachine, InvalidTransitionError } from '../../src/common/task-state-machine.js';

describe('TaskStateMachine', () => {
  describe('valid transitions', () => {
    it('allows created -> claimed', () => {
      expect(TaskStateMachine.transition(TaskStatus.CREATED, 'claim')).toBe(TaskStatus.CLAIMED);
    });

    it('allows claimed -> created (unclaim)', () => {
      expect(TaskStateMachine.transition(TaskStatus.CLAIMED, 'unclaim')).toBe(TaskStatus.CREATED);
    });

    it('allows claimed -> completed', () => {
      expect(TaskStateMachine.transition(TaskStatus.CLAIMED, 'complete')).toBe(TaskStatus.COMPLETED);
    });

    it('allows created -> cancelled', () => {
      expect(TaskStateMachine.transition(TaskStatus.CREATED, 'cancel')).toBe(TaskStatus.CANCELLED);
    });

    it('allows claimed -> cancelled', () => {
      expect(TaskStateMachine.transition(TaskStatus.CLAIMED, 'cancel')).toBe(TaskStatus.CANCELLED);
    });
  });

  describe('invalid transitions', () => {
    it('rejects created -> completed (must claim first)', () => {
      expect(() => TaskStateMachine.transition(TaskStatus.CREATED, 'complete'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects completed -> any action', () => {
      expect(() => TaskStateMachine.transition(TaskStatus.COMPLETED, 'claim'))
        .toThrow(InvalidTransitionError);
      expect(() => TaskStateMachine.transition(TaskStatus.COMPLETED, 'cancel'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects cancelled -> any action', () => {
      expect(() => TaskStateMachine.transition(TaskStatus.CANCELLED, 'claim'))
        .toThrow(InvalidTransitionError);
      expect(() => TaskStateMachine.transition(TaskStatus.CANCELLED, 'complete'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects created -> unclaim (not claimed)', () => {
      expect(() => TaskStateMachine.transition(TaskStatus.CREATED, 'unclaim'))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(TaskStateMachine.canTransition(TaskStatus.CREATED, 'claim')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(TaskStateMachine.canTransition(TaskStatus.CREATED, 'complete')).toBe(false);
    });
  });

  describe('availableActions', () => {
    it('returns claim and cancel for created', () => {
      expect(TaskStateMachine.availableActions(TaskStatus.CREATED)).toEqual(['claim', 'cancel']);
    });

    it('returns unclaim, complete, and cancel for claimed', () => {
      expect(TaskStateMachine.availableActions(TaskStatus.CLAIMED)).toEqual(['unclaim', 'complete', 'cancel']);
    });

    it('returns empty array for terminal states', () => {
      expect(TaskStateMachine.availableActions(TaskStatus.COMPLETED)).toEqual([]);
      expect(TaskStateMachine.availableActions(TaskStatus.CANCELLED)).toEqual([]);
    });
  });

  describe('error messages', () => {
    it('includes current status and attempted action in error', () => {
      try {
        TaskStateMachine.transition(TaskStatus.CREATED, 'complete');
      } catch (e) {
        expect((e as InvalidTransitionError).message).toContain('created');
        expect((e as InvalidTransitionError).message).toContain('complete');
      }
    });
  });
});
