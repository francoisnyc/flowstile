import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getCase, getAttachmentUrl, listCaseComments, createCaseComment } from '../api/client.js';
import { useAuth } from '../context/AuthContext.js';
import type { CaseDetail, CaseComment, CaseTask } from '../types.js';

function caseLabel(c: CaseDetail): string {
  return c.title || c.processDefinitionName || c.processInstanceId;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

function taskActorLine(task: CaseTask): string {
  if (task.status === 'completed' && task.completedAt) {
    const name = task.assignee?.displayName ?? 'Unknown';
    return `Completed by ${name} · ${relativeTime(task.completedAt)}`;
  }
  if (task.status === 'claimed') {
    const name = task.assignee?.displayName ?? 'Unknown';
    return `Claimed by ${name} · ${relativeTime(task.updatedAt)}`;
  }
  if (task.status === 'cancelled') {
    return `Cancelled · ${relativeTime(task.updatedAt)}`;
  }
  return 'Waiting';
}

function TaskTimeline({ tasks, navigate }: { tasks: CaseTask[]; navigate: (path: string) => void }) {
  return (
    <div className="case-timeline">
      {tasks.map((task, i) => {
        const isLast = i === tasks.length - 1;
        const statusClass = task.status === 'completed' ? 'completed'
          : task.status === 'claimed' ? 'active'
          : task.status === 'cancelled' ? 'cancelled'
          : 'waiting';

        return (
          <div key={task.id} className="timeline-entry">
            <div className="timeline-track">
              <div className={`timeline-dot ${statusClass}`} />
              {!isLast && <div className="timeline-line" />}
            </div>
            <div className="timeline-content">
              <div className="timeline-header">
                <span className={`timeline-task-name ${task.status === 'cancelled' ? 'struck' : ''}`}>
                  {task.taskDefinition?.code ?? 'Task'}
                </span>
                <span className={`timeline-status ${statusClass}`}>{task.status}</span>
              </div>
              <div className="timeline-actor">{taskActorLine(task)}</div>
              {(task.status === 'claimed' || task.status === 'created') && (
                <button
                  className={`timeline-card ${statusClass}`}
                  onClick={() => navigate(`/inbox?task=${task.id}`)}
                >
                  <span>{task.status === 'claimed' ? 'In progress' : 'Awaiting action'}</span>
                  <span className="timeline-card-link">Open →</span>
                </button>
              )}
              {task.status === 'completed' && (
                <button
                  className="timeline-card completed"
                  onClick={() => navigate(`/inbox?task=${task.id}`)}
                >
                  <span>Completed</span>
                  <span className="timeline-card-link">View →</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CollapsiblePanel({ title, count, defaultOpen = true, children }: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="detail-panel">
      <button className="detail-panel-header" onClick={() => setOpen(!open)}>
        <span>{title}{count !== undefined ? ` (${count})` : ''}</span>
        <span className="panel-chevron">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="detail-panel-body">{children}</div>}
    </div>
  );
}

function CommentList({ caseId, canPost }: { caseId: string; canPost: boolean }) {
  const [comments, setComments] = useState<CaseComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    listCaseComments(caseId).then(({ items }) => {
      setComments(items);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [caseId]);

  const handlePost = async () => {
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      const comment = await createCaseComment(caseId, body.trim());
      setComments((prev) => [...prev, comment]);
      setBody('');
    } finally {
      setPosting(false);
    }
  };

  if (!loaded) return <p className="text-muted">Loading…</p>;

  return (
    <div className="comment-list">
      {comments.length === 0 && <p className="text-muted">No comments yet</p>}
      {comments.map((c) => (
        <div key={c.id} className="comment" data-testid="case-comment">
          <div className="comment-header">
            <span className="comment-avatar">{c.author.displayName.charAt(0).toUpperCase()}</span>
            <span className="comment-author">{c.author.displayName}</span>
            <span className="comment-time">{relativeTime(c.createdAt)}</span>
          </div>
          <div className="comment-body">{c.body}</div>
        </div>
      ))}
      {canPost && (
        <div className="comment-input">
          <textarea
            className="comment-textarea"
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            data-testid="comment-input"
          />
          <button
            className="comment-post-btn"
            onClick={handlePost}
            disabled={!body.trim() || posting}
            data-testid="comment-post-btn"
          >
            Post
          </button>
        </div>
      )}
    </div>
  );
}

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchCase = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setCaseDetail(await getCase(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load case');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchCase(); }, [fetchCase]);

  const copyPid = () => {
    if (!caseDetail) return;
    navigator.clipboard?.writeText(caseDetail.processInstanceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (loading) return <div className="case-detail-page"><p className="empty">Loading…</p></div>;
  if (error) return <div className="case-detail-page"><p className="error-banner">{error}</p></div>;
  if (!caseDetail) return null;

  const entity = caseDetail.entity ?? {};
  const variableEntries = Object.entries(entity);
  const completedCount = caseDetail.tasks.filter((t) => t.status === 'completed').length;
  const totalCount = caseDetail.tasks.length;

  return (
    <div className="case-detail-page">
      <button className="back-link" onClick={() => navigate('/cases')}>← Cases</button>

      <header className="case-detail-header">
        <h1>{caseLabel(caseDetail)}</h1>
        <div className="case-detail-subline">
          <button className="pid-chip" onClick={copyPid} title="Copy case reference">
            {caseDetail.processInstanceId}
            <span className="pid-copy">{copied ? '✓ copied' : '⧉'}</span>
          </button>
          <span className={`status-badge ${caseDetail.status}`}>
            {caseDetail.status.replace('_', ' ')}
          </span>
          {totalCount > 0 && (
            <span className="case-progress-summary" data-testid="case-progress">
              {completedCount} of {totalCount} tasks completed
            </span>
          )}
        </div>
      </header>

      <div className="case-detail-body">
        {/* Left: Task Timeline */}
        <div className="case-detail-main">
          <h2 className="section-label">Timeline</h2>
          {caseDetail.tasks.length === 0 ? (
            <p className="empty">No tasks yet</p>
          ) : (
            <TaskTimeline tasks={caseDetail.tasks} navigate={navigate} />
          )}
        </div>

        {/* Right: Detail Panels */}
        <div className="case-detail-sidebar">
          <CollapsiblePanel title="Case Data" count={variableEntries.length}>
            {variableEntries.length === 0 ? (
              <p className="text-muted">No data</p>
            ) : (
              <dl className="panel-kv">
                {variableEntries.map(([key, value]) => (
                  <div key={key} className="panel-kv-item">
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel title="Documents" count={caseDetail.attachments.length}>
            {caseDetail.attachments.length === 0 ? (
              <p className="text-muted">No documents</p>
            ) : (
              <ul className="panel-doc-list">
                {caseDetail.attachments.map((att) => (
                  <li key={att.attachmentId}>
                    <span className="doc-icon">📄</span>
                    <a href={getAttachmentUrl(att.taskId, att.attachmentId)} target="_blank" rel="noreferrer">
                      {att.fileName}
                    </a>
                    <span className="doc-size">{formatBytes(att.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel title="Comments" count={caseDetail.commentCount}>
            <CommentList caseId={caseDetail.id} canPost={user?.roles.some((r) => r.permissions.includes('tasks:write')) ?? false} />
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}
