import React, { useState, useCallback, useEffect } from 'react';
import { useFlowstileTask } from './useFlowstileTask.js';
import { FlowstileForm } from './FlowstileForm.js';
import { FileField } from './FileField.js';
import type { FlowstileApiError, AttachmentRef, AttachmentFieldConfig } from './types.js';

export interface FlowstileTaskProps {
  taskId: string;
  baseUrl?: string;
  token?: string;
  getToken?: () => Promise<string>;
  onComplete?: (data: Record<string, unknown>) => void;
  onError?: (error: FlowstileApiError) => void;
  onClaim?: () => void;
}

export function FlowstileTask({
  taskId,
  baseUrl,
  token,
  getToken,
  onComplete,
  onError,
  onClaim,
}: FlowstileTaskProps) {
  const { task, form, data, status, error, validationErrors, isMutating, claim, complete, client } =
    useFlowstileTask(taskId, { baseUrl, token, getToken });
  const [formData, setFormData] = useState<Record<string, unknown>>({});

  // Sync form data when task loads/changes
  useEffect(() => {
    setFormData(data);
  }, [task?.id, task?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report fetch errors
  useEffect(() => {
    if (error && onError) onError(error);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClaim = useCallback(async () => {
    try {
      await claim();
      onClaim?.();
    } catch (err) {
      onError?.(err as FlowstileApiError);
    }
  }, [claim, onClaim, onError]);

  const handleSubmit = useCallback(async (outcomeValue?: string) => {
    const outcomeKey = task?.form?.outcomeKey ?? 'DECISION';
    const payload = outcomeValue !== undefined
      ? { ...formData, [outcomeKey]: outcomeValue }
      : formData;
    try {
      await complete(payload);
      onComplete?.(payload);
    } catch (err) {
      onError?.(err as FlowstileApiError);
    }
  }, [complete, formData, onComplete, onError, task?.form?.outcomeKey]);

  if (status === 'loading') {
    return <div className="flowstile-task flowstile-task--loading">Loading...</div>;
  }

  if (status === 'error' || !task || !form) {
    return (
      <div className="flowstile-task flowstile-task--error">
        {error?.message ?? 'Failed to load task'}
      </div>
    );
  }

  const { actions } = task;
  const outcomes = form.outcomes ?? null;
  const hasOutcomes = Array.isArray(outcomes) && outcomes.length > 0;

  // Collect attachment fields from the form schema
  const attachmentFields = new Map<string, AttachmentFieldConfig>();
  if (form.jsonSchema?.properties) {
    const props = form.jsonSchema.properties as Record<string, Record<string, unknown>>;
    for (const [key, fieldSchema] of Object.entries(props)) {
      if (fieldSchema['x-flowstile-attachment']) {
        attachmentFields.set(key, (fieldSchema['x-flowstile-attachment'] as AttachmentFieldConfig) ?? {});
      }
    }
  }

  return (
    <div className="flowstile-task">
      <FlowstileForm
        schema={form.jsonSchema}
        uiSchema={form.uiSchema}
        data={formData}
        onChange={setFormData}
        readOnly={!actions.canComplete}
        validationErrors={validationErrors ?? undefined}
      />
      {attachmentFields.size > 0 && client && (
        <div className="flowstile-attachment-fields">
          {[...attachmentFields.entries()].map(([key, cfg]) => (
            <div key={key} className="flowstile-attachment-field">
              <label className="flowstile-attachment-label">{key}</label>
              <FileField
                taskId={taskId}
                fieldKey={key}
                config={cfg}
                value={formData[key] as AttachmentRef | AttachmentRef[] | null}
                readOnly={!actions.canComplete}
                client={client}
                onChange={(next) => setFormData((prev) => ({ ...prev, [key]: next }))}
              />
            </div>
          ))}
        </div>
      )}
      <div className="flowstile-task-actions">
        {actions.canClaim && (
          <button
            className="flowstile-btn flowstile-btn--claim"
            onClick={handleClaim}
            disabled={isMutating}
          >
            Claim
          </button>
        )}
        {actions.canComplete && hasOutcomes && outcomes!.map((o) => (
          <button
            key={o.value}
            className={`flowstile-btn flowstile-btn--outcome flowstile-btn--${o.style ?? 'secondary'}`}
            onClick={() => handleSubmit(o.value)}
            disabled={isMutating}
          >
            {o.label}
          </button>
        ))}
        {actions.canComplete && !hasOutcomes && (
          <button
            className="flowstile-btn flowstile-btn--submit"
            onClick={() => handleSubmit()}
            disabled={isMutating}
          >
            Submit
          </button>
        )}
      </div>
    </div>
  );
}
