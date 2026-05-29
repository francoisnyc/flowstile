import { useState, useEffect, useCallback, useRef } from 'react';
import { FlowstileClient } from './client.js';
import type {
  Task,
  TaskForm,
  FlowstileApiError,
  UseFlowstileTaskOptions,
  UseFlowstileTaskResult,
} from './types.js';

// Shape of the error thrown by FlowstileClient (FlowstileApiErrorImpl)
interface ApiErrorWithValidation extends FlowstileApiError {
  validationErrors?: Record<string, string[]>;
}

export function useFlowstileTask(
  taskId: string,
  opts?: UseFlowstileTaskOptions,
): UseFlowstileTaskResult {
  const [task, setTask] = useState<Task | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<FlowstileApiError | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string[]> | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  // Track options by value so we only recreate the client when they change
  const baseUrl = opts?.baseUrl;
  const token = opts?.token;
  const getToken = opts?.getToken;

  const clientRef = useRef<FlowstileClient | null>(null);

  // Recreate client when auth options change
  useEffect(() => {
    clientRef.current = new FlowstileClient({ baseUrl, token, getToken });
  }, [baseUrl, token, getToken]);

  const fetchTask = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;

    setStatus('loading');
    setError(null);

    try {
      const fetched = await client.getTask(taskId);
      setTask(fetched);
      setStatus('ready');
    } catch (err) {
      setError(err as FlowstileApiError);
      setStatus('error');
    }
  }, [taskId]);

  // Fetch on mount and when taskId changes (client is initialized synchronously via useEffect above,
  // but we need to make sure we always have a client before fetching)
  useEffect(() => {
    // Ensure client exists (first render: useEffect order is deterministic — both run after render)
    if (!clientRef.current) {
      clientRef.current = new FlowstileClient({ baseUrl, token, getToken });
    }
    fetchTask();
  }, [fetchTask]); // fetchTask already depends on taskId

  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setIsMutating(true);
      setValidationErrors(null);
      setError(null);

      try {
        await action();
        await fetchTask();
      } catch (err) {
        const apiErr = err as ApiErrorWithValidation;
        setError(apiErr);
        if (apiErr.validationErrors) {
          setValidationErrors(apiErr.validationErrors);
        }
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [fetchTask],
  );

  const claim = useCallback(
    () => runAction(() => clientRef.current!.claimTask(taskId)),
    [taskId, runAction],
  );

  const unclaim = useCallback(
    () => runAction(() => clientRef.current!.unclaimTask(taskId)),
    [taskId, runAction],
  );

  const complete = useCallback(
    (submissionData: Record<string, unknown>) =>
      runAction(() => clientRef.current!.completeTask(taskId, submissionData)),
    [taskId, runAction],
  );

  const cancel = useCallback(
    () => runAction(() => clientRef.current!.cancelTask(taskId)),
    [taskId, runAction],
  );

  const form: TaskForm | null = task?.form ?? null;

  const data: Record<string, unknown> = task
    ? {
        ...task.contextData,
        ...task.inputData,
        ...task.submissionData,
      }
    : {};

  return {
    task,
    form,
    data,
    status,
    error,
    validationErrors,
    isMutating,
    claim,
    unclaim,
    complete,
    cancel,
    refetch: fetchTask,
    client: clientRef.current,
  };
}
