import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { listCases } from '../api/client.js';
import type { CaseSummary, CaseStatus } from '../types.js';

type StatusFilter = 'all' | CaseStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Pending' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Title shown for a case: explicit title, else process name, else the
// processInstanceId (the shareable reference). Never a fabricated number.
function caseLabel(c: CaseSummary): string {
  return c.title || c.processDefinitionName || c.processInstanceId;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const fetchCases = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter === 'all' ? undefined : { status: filter };
      const page = await listCases(params);
      setCases(page.items);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchCases(); }, [fetchCases]);

  return (
    <div className="cases-page">
      <div className="cases-header">
        <h1>Cases</h1>
        <div className="filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`chip ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cases-list">
        {loading ? (
          <p className="empty">Loading…</p>
        ) : cases.length === 0 ? (
          <p className="empty">No cases</p>
        ) : (
          cases.map((c) => (
            <button
              key={c.id}
              className="case-card"
              onClick={() => navigate(`/cases/${c.id}`)}
            >
              <div className="case-card-main">
                <span className="case-card-title">{caseLabel(c)}</span>
                <span className="case-card-pid">{c.processInstanceId}</span>
              </div>
              <div className="case-card-meta">
                <span className={`status-badge ${c.status}`}>
                  {c.status.replace('_', ' ')}
                </span>
                <span className="case-card-tasks">
                  {c.openTaskCount} open · {c.taskCount} total
                </span>
                <span className="case-card-time">{relativeTime(c.createdAt)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
