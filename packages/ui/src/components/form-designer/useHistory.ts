import { useState, useCallback, useRef } from 'react';

const MAX_HISTORY = 50;

interface HistoryResult<T> {
  state: T;
  push: (next: T) => void;
  undo: () => void;
  redo: () => void;
  reset: (initial: T) => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHistory<T>(initialState: T): HistoryResult<T> {
  const [state, setState] = useState<T>(initialState);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const push = useCallback((next: T) => {
    setState((current) => {
      past.current = [...past.current, current].slice(-MAX_HISTORY);
      future.current = [];
      setCanUndo(true);
      setCanRedo(false);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setState((current) => {
      if (past.current.length === 0) return current;
      const previous = past.current[past.current.length - 1];
      past.current = past.current.slice(0, -1);
      future.current = [current, ...future.current];
      setCanUndo(past.current.length > 0);
      setCanRedo(true);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setState((current) => {
      if (future.current.length === 0) return current;
      const next = future.current[0];
      future.current = future.current.slice(1);
      past.current = [...past.current, current];
      setCanUndo(true);
      setCanRedo(future.current.length > 0);
      return next;
    });
  }, []);

  const reset = useCallback((initial: T) => {
    past.current = [];
    future.current = [];
    setState(initial);
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  return { state, push, undo, redo, reset, canUndo, canRedo };
}
