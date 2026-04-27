import React, { useState, useEffect } from 'react';
import { JsonForms } from '@jsonforms/react';
import { vanillaRenderers, vanillaCells } from '@jsonforms/vanilla-renderers';
import type { UISchemaElement } from '@jsonforms/core';
import type { Task } from '../types.js';
import { claimTask, unclaimTask, completeTask } from '../api/client.js';
import { useAuth } from '../context/AuthContext.js';

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
    setFormData(task?.submissionData ?? {});
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
          {isEditable && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => act(() => completeTask(task.id, formData))}
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
        </div>
      ) : (
        <p className="empty">No form attached to this task</p>
      )}
    </div>
  );
}
