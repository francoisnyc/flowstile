import React, { useState, useEffect } from 'react';
import { JsonForms } from '@jsonforms/react';
import { vanillaRenderers, vanillaCells } from '@jsonforms/vanilla-renderers';
import type { UISchemaElement } from '@jsonforms/core';
import type { Task, AttachmentRef, AttachmentFieldConfig } from '../types.js';
import { claimTask, unclaimTask, completeTask } from '../api/client.js';
import { useAuth } from '../context/AuthContext.js';
import FileField from './FileField.js';

interface Props {
  task: Task | null;
  onTaskUpdated: (id: string) => void;
}

export default function TaskDetail({ task, onTaskUpdated }: Props) {
  const { user } = useAuth();
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFormData({
      ...(task?.contextData ?? {}),
      ...(task?.inputData ?? {}),
      ...(task?.submissionData ?? {}),
    });
    setError(null);
  }, [task?.id]);

  if (!task) {
    return (
      <div className="task-detail empty">
        <p>Select a task to view details</p>
      </div>
    );
  }

  const isAssignedToMe = task.assigneeId === user?.id;
  const isClaimed = task.status === 'claimed';
  const isCreated = task.status === 'created';
  const isEditable = isClaimed && isAssignedToMe;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onTaskUpdated(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  // Collect attachment fields from the form schema for custom rendering
  const attachmentFields = new Map<string, AttachmentFieldConfig>();
  if (task.form?.jsonSchema?.properties) {
    const props = task.form.jsonSchema.properties as Record<string, Record<string, unknown>>;
    for (const [key, fieldSchema] of Object.entries(props)) {
      if (fieldSchema['x-flowstile-attachment']) {
        attachmentFields.set(key, (fieldSchema['x-flowstile-attachment'] as AttachmentFieldConfig) ?? {});
      }
    }
  }

  const outcomes = task.form?.outcomes ?? null;
  const outcomeKey = task.form?.outcomeKey ?? 'DECISION';
  const hasOutcomes = Array.isArray(outcomes) && outcomes.length > 0;

  const completeWithOutcome = (value?: string) => {
    // Merge original task data under formData so readonly/array fields that
    // JsonForms may strip from its onChange output are still present in the
    // submission and pass server-side required-field validation.
    const safeData: Record<string, unknown> = {
      ...(task.contextData ?? {}),
      ...(task.inputData ?? {}),
      ...(task.submissionData ?? {}),
      ...formData,
      ...(value !== undefined ? { [outcomeKey]: value } : {}),
    };
    act(() => completeTask(task.id, safeData));
  };

  return (
    <div className="task-detail">
      <div className="task-detail-header">
        <div>
          <h2>{task.taskDefinition?.code ?? task.taskDefinitionId.slice(0, 8)}</h2>
          <div className="task-meta" style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            {task.processInstanceId && <span>Ref: {task.processInstanceId}</span>}
            <span>Created {new Date(task.createdAt).toLocaleString()}</span>
            <span className={`status-badge ${task.status}`}>{task.status}</span>
          </div>
        </div>
        <div className="task-actions">
          {isCreated && (
            <button disabled={busy} onClick={() => act(() => claimTask(task.id))}>
              Claim
            </button>
          )}
          {isClaimed && isAssignedToMe && (
            <button disabled={busy} onClick={() => act(() => unclaimTask(task.id))}>
              Unassign
            </button>
          )}
          {isEditable && hasOutcomes && outcomes!.map((o) => (
            <button
              key={o.value}
              className={o.style ?? 'secondary'}
              disabled={busy}
              onClick={() => completeWithOutcome(o.value)}
            >
              {o.label}
            </button>
          ))}
          {isEditable && !hasOutcomes && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => completeWithOutcome()}
            >
              Complete
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {task.form ? (
        <div className="form-container">
          <JsonForms
            schema={task.form.jsonSchema}
            uischema={task.form.uiSchema as unknown as UISchemaElement}
            data={formData}
            renderers={vanillaRenderers}
            cells={vanillaCells}
            onChange={({ data }) => setFormData(data as Record<string, unknown>)}
            readonly={!isEditable}
          />
          {attachmentFields.size > 0 && (
            <div className="attachment-fields" style={{ marginTop: 16 }}>
              {[...attachmentFields.entries()].map(([key, cfg]) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>{key}</label>
                  <FileField
                    taskId={task.id}
                    fieldKey={key}
                    config={cfg}
                    value={formData[key] as AttachmentRef | AttachmentRef[] | null}
                    readOnly={!isEditable}
                    onChange={(next) => setFormData((prev) => ({ ...prev, [key]: next }))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="empty">No form attached to this task</p>
      )}
    </div>
  );
}
