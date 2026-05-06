import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistory } from './useHistory.js';

describe('useHistory', () => {
  it('starts with initial state, canUndo=false, canRedo=false', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    expect(result.current.state).toEqual({ count: 0 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('push adds new state, canUndo=true', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    act(() => {
      result.current.push({ count: 1 });
    });
    expect(result.current.state).toEqual({ count: 1 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo returns to previous state, canRedo=true', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    act(() => {
      result.current.push({ count: 1 });
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.state).toEqual({ count: 0 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('redo after undo returns to pushed state', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    act(() => {
      result.current.push({ count: 1 });
    });
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.redo();
    });
    expect(result.current.state).toEqual({ count: 1 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('push after undo clears redo stack', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    act(() => {
      result.current.push({ count: 1 });
    });
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.push({ count: 2 });
    });
    expect(result.current.state).toEqual({ count: 2 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('caps history at 50 entries', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    // Push 60 states on top of the initial one
    act(() => {
      for (let i = 1; i <= 60; i++) {
        result.current.push({ count: i });
      }
    });
    expect(result.current.state).toEqual({ count: 60 });
    // Should be able to undo 50 times (past stack capped at 50)
    for (let i = 0; i < 50; i++) {
      act(() => {
        result.current.undo();
      });
    }
    expect(result.current.canUndo).toBe(false);
    // 51st undo should not work
    const stateAfter50Undos = result.current.state;
    act(() => {
      result.current.undo();
    });
    expect(result.current.state).toEqual(stateAfter50Undos);
  });

  it('reset replaces state and clears both stacks', () => {
    const { result } = renderHook(() => useHistory({ count: 0 }));
    act(() => {
      result.current.push({ count: 1 });
      result.current.push({ count: 2 });
    });
    act(() => {
      result.current.undo();
    });
    // Now has past entries and a future entry
    act(() => {
      result.current.reset({ count: 99 });
    });
    expect(result.current.state).toEqual({ count: 99 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
