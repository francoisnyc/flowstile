import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  listForms, getFormVersions, createForm, updateDraft, publishForm,
} from '../api/client.js';
import type { FormSummary, FormDefinition } from '../types.js';
import FormEditor from '../components/FormEditor.js';
import FormPreview from '../components/FormPreview.js';

const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };
const EMPTY_UI: Record<string, unknown> = { type: 'VerticalLayout', elements: [] };

export default function FormDesignerPage() {
  const { code: routeCode } = useParams<{ code?: string }>();
  const navigate = useNavigate();

  const [forms, setForms] = useState<FormSummary[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(routeCode ?? null);
  const [draft, setDraft] = useState<FormDefinition | null>(null);
  const [publishedVersions, setPublishedVersions] = useState<FormDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');

  const reloadForms = () => listForms().then(setForms).catch(console.error);

  useEffect(() => { reloadForms(); }, []);

  useEffect(() => {
    if (!selectedCode) { setDraft(null); setPublishedVersions([]); return; }
    getFormVersions(selectedCode).then((vs) => {
      setPublishedVersions(vs.filter((v) => v.status === 'published'));
      setDraft(vs.find((v) => v.status === 'draft') ?? null);
    }).catch(console.error);
  }, [selectedCode]);

  const handleSelect = (code: string) => {
    setSelectedCode(code);
    navigate(`/forms/${code}`);
  };

  const handleCreate = async () => {
    const code = newCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const f = await createForm({ code, jsonSchema: EMPTY_SCHEMA, uiSchema: EMPTY_UI });
      await reloadForms();
      setNewCode('');
      handleSelect(f.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!selectedCode || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateDraft(selectedCode, {
        jsonSchema: draft.jsonSchema,
        uiSchema: draft.uiSchema,
        visibilityRules: draft.visibilityRules,
        formMessages: draft.formMessages,
      });
      setDraft(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!selectedCode) return;
    setBusy(true);
    setError(null);
    try {
      await publishForm(selectedCode);
      const vs = await getFormVersions(selectedCode);
      setPublishedVersions(vs.filter((v) => v.status === 'published'));
      setDraft(null);
      await reloadForms();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDraft = async () => {
    if (!selectedCode) return;
    setBusy(true);
    try {
      const saved = await updateDraft(selectedCode, {});
      const vs = await getFormVersions(selectedCode);
      setPublishedVersions(vs.filter((v) => v.status === 'published'));
      setDraft(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const latestPublished = publishedVersions[publishedVersions.length - 1];

  return (
    <div className="form-designer">
      {/* Sidebar */}
      <aside className="form-sidebar">
        <h3>Forms</h3>
        <ul className="form-list">
          {forms.map((f) => (
            <li
              key={f.code}
              className={`form-item ${f.code === selectedCode ? 'selected' : ''}`}
              onClick={() => handleSelect(f.code)}
            >
              <span>{f.code}</span>
              <span style={{ display: 'flex', gap: 4 }}>
                {f.hasDraft && <span className="badge">draft</span>}
                {f.latestPublishedVersion !== null && (
                  <span className="version">v{f.latestPublishedVersion}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div className="new-form">
          <input
            placeholder="FORM_CODE"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button disabled={busy || !newCode.trim()} onClick={handleCreate}>
            New
          </button>
        </div>
      </aside>

      {/* Workspace */}
      {selectedCode && draft ? (
        <div className="form-workspace">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-toolbar">
            <span className="form-code">{selectedCode}</span>
            <span>
              {latestPublished
                ? `v${latestPublished.version} published — editing draft`
                : 'Draft (unpublished)'}
            </span>
            <button disabled={busy} onClick={handleSaveDraft}>Save draft</button>
            <button className="primary" disabled={busy} onClick={handlePublish}>
              Publish
            </button>
          </div>
          <div className="editor-preview-split">
            <FormEditor
              form={draft}
              onChange={(updated) => setDraft((d) => d ? { ...d, ...updated } : d)}
            />
            <FormPreview form={draft} />
          </div>
        </div>
      ) : selectedCode ? (
        <div className="form-workspace empty">
          {error && <div className="error-banner">{error}</div>}
          <p>
            {latestPublished
              ? `v${latestPublished.version} published — `
              : 'No published versions — '}
            <button disabled={busy} onClick={handleCreateDraft}>
              Create draft
            </button>
          </p>
        </div>
      ) : (
        <div className="form-workspace empty">
          <p>Select a form or create a new one</p>
        </div>
      )}
    </div>
  );
}
