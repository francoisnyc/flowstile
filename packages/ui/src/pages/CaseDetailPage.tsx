import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getCase, getAttachmentUrl } from '../api/client.js';
import type { CaseDetail } from '../types.js';

function caseLabel(c: CaseDetail): string {
  return c.title || c.processDefinitionName || c.processInstanceId;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const TASK_STATUS_GLYPH: Record<string, string> = {
  created: '○',
  claimed: '◐',
  completed: '✓',
  cancelled: '✕',
};

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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

  const variables = caseDetail.variables ?? {};
  const variableEntries = Object.entries(variables);

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
        </div>

        {variableEntries.length > 0 && (
          <dl className="case-variables">
            {variableEntries.map(([key, value]) => (
              <div className="case-variable" key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>

      <section className="case-section">
        <h2>Tasks</h2>
        {caseDetail.tasks.length === 0 ? (
          <p className="empty">No tasks yet</p>
        ) : (
          <ul className="case-task-list">
            {caseDetail.tasks.map((t) => (
              <li
                key={t.id}
                className="case-task-row"
                onClick={() => navigate(`/inbox?task=${t.id}`)}
              >
                <span className={`task-glyph ${t.status}`}>{TASK_STATUS_GLYPH[t.status] ?? '○'}</span>
                <span className="case-task-code">{t.taskDefinition?.code ?? 'Task'}</span>
                <span className="case-task-status">{t.status}</span>
                <span className="case-task-assignee">
                  {t.assignee ? t.assignee.displayName : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="case-section">
        <h2>Documents</h2>
        {caseDetail.attachments.length === 0 ? (
          <p className="empty">No documents</p>
        ) : (
          <ul className="case-doc-list">
            {caseDetail.attachments.map((att) => (
              <li key={att.attachmentId} className="case-doc-row">
                <span className="case-doc-icon">📄</span>
                <a
                  href={getAttachmentUrl(att.taskId, att.attachmentId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {att.fileName}
                </a>
                <span className="case-doc-field">{att.fieldKey}</span>
                <span className="case-doc-size">{formatBytes(att.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
