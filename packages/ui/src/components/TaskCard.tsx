import React from 'react';
import type { Task } from '../types.js';

const PRIORITY_COLOR: Record<string, string> = {
  low: '#8b949e',
  normal: '#1f6feb',
  high: '#d29922',
  urgent: '#da3633',
};

interface Props {
  task: Task;
  selected: boolean;
  onClick: () => void;
}

export default function TaskCard({ task, selected, onClick }: Props) {
  const dueDate = task.dueDate
    ? new Date(task.dueDate).toLocaleDateString()
    : null;

  return (
    <div className={`task-card ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="task-card-header">
        <span className="task-name">
          {task.taskDefinition?.code ?? task.taskDefinitionId.slice(0, 8)}
        </span>
        <span className="priority-badge" style={{ color: PRIORITY_COLOR[task.priority] }}>
          {task.priority}
        </span>
      </div>
      {task.processInstanceId && (
        <div className="task-meta">{task.processInstanceId}</div>
      )}
      <div className="task-footer">
        <span>{task.assignee?.displayName ?? 'Unassigned'}</span>
        {dueDate && <span>Due {dueDate}</span>}
      </div>
    </div>
  );
}
