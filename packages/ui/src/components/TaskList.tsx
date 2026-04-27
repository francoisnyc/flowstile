import React from 'react';
import type { Task } from '../types.js';
import { useAuth } from '../context/AuthContext.js';
import TaskCard from './TaskCard.js';

export type Filter = 'mine' | 'unassigned' | 'all';

interface Props {
  tasks: Task[];
  loading: boolean;
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  selectedId?: string;
  onSelect: (t: Task) => void;
}

const FILTER_LABELS: Record<Filter, string> = {
  mine: 'Assigned to me',
  unassigned: 'Unassigned',
  all: 'All open',
};

export default function TaskList({
  tasks, loading, filter, onFilterChange, selectedId, onSelect,
}: Props) {
  const { user } = useAuth();

  const filtered = tasks.filter((t) => {
    if (filter === 'mine') return t.assigneeId === user?.id;
    if (filter === 'unassigned') return t.assigneeId === null;
    return true;
  });

  return (
    <div className="task-list">
      <div className="filters">
        {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
          <button
            key={f}
            className={`chip ${filter === f ? 'active' : ''}`}
            onClick={() => onFilterChange(f)}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>
      <div className="task-list-items">
        {loading ? (
          <p className="empty">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="empty">No tasks</p>
        ) : (
          filtered.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              onClick={() => onSelect(t)}
            />
          ))
        )}
      </div>
    </div>
  );
}
