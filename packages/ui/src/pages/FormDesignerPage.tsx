import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  listForms, getFormVersions, createForm, updateDraft, publishForm,
} from '../api/client.js';
import type { FormSummary, FormDefinition } from '../types.js';
import FormEditor from '../components/FormEditor.js';
import FormPreview from '../components/FormPreview.js';
import DesignerToolbar from '../components/form-designer/DesignerToolbar.js';
import type { DesignerTab } from '../components/form-designer/DesignerToolbar.js';
import VisualBuilder from '../components/form-designer/VisualBuilder.js';
import OutcomesPanel from '../components/form-designer/OutcomesPanel.js';
import { useHistory } from '../components/form-designer/useHistory.js';
import { toSchema } from '../components/form-designer/toSchema.js';
import { fromSchema } from '../components/form-designer/fromSchema.js';
import type { FieldDefinition } from '../components/form-designer/types.js';

const EMPTY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  'x-flowstile-builder': true,
};
const EMPTY_UI: Record<string, unknown> = { type: 'VerticalLayout', elements: [] };

// Keep validation honest: when a form declares outcome buttons, the chosen
// value must be a real string-enum property in the schema so the server's
// existing schema validation rejects unknown outcomes.
function withOutcomeEnum(
  jsonSchema: Record<string, unknown>,
  draft: FormDefinition,
): Record<string, unknown> {
  const outcomes = draft.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length === 0) return jsonSchema;
  const key = draft.outcomeKey || 'DECISION';
  const properties = { ...(jsonSchema.properties as Record<string, unknown> | undefined ?? {}) };
  properties[key] = { type: 'string', enum: outcomes.map((o) => o.value) };
  return { ...jsonSchema, properties };
}

export default function FormDesignerPage() {
  const { code: routeCode } = useParams<{ code?: string }>();
  const navigate = useNavigate();

  // ── Form list / selection state ──────────────────────────────────────────
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(routeCode ?? null);
  const [draft, setDraft] = useState<FormDefinition | null>(null);
  const [publishedVersions, setPublishedVersions] = useState<FormDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');

  // ── Designer state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<DesignerTab>('designer');
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const history = useHistory<FieldDefinition[]>([]);

  // ── Form list ────────────────────────────────────────────────────────────
  const reloadForms = () => listForms().then((p) => setForms(p.items)).catch(console.error);

  useEffect(() => { reloadForms(); }, []);

  // ── Load versions when selectedCode changes ──────────────────────────────
  useEffect(() => {
    if (!selectedCode) {
      setDraft(null);
      setPublishedVersions([]);
      history.reset([]);
      return;
    }
    getFormVersions(selectedCode).then((vs) => {
      const published = vs.filter((v) => v.status === 'published');
      const draftVersion = vs.find((v) => v.status === 'draft') ?? null;
      setPublishedVersions(published);
      setDraft(draftVersion);
      if (draftVersion) {
        const fields = fromSchema({
          jsonSchema: draftVersion.jsonSchema,
          uiSchema: draftVersion.uiSchema,
          visibilityRules: draftVersion.visibilityRules ?? {},
        });
        history.reset(fields);
      } else {
        history.reset([]);
      }
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);

  // ── Tab switching with schema sync ───────────────────────────────────────
  const handleTabChange = useCallback((tab: DesignerTab) => {
    if (tab === activeTab) return;

    if (activeTab === 'designer') {
      // Designer → anything: sync fields → draft
      const schemaOut = toSchema(history.state);
      setDraft((d) => d ? {
        ...d,
        jsonSchema: schemaOut.jsonSchema,
        uiSchema: schemaOut.uiSchema,
        visibilityRules: schemaOut.visibilityRules,
      } : d);
    }

    if (tab === 'designer') {
      // Anything → Designer: parse draft → fields
      if (!draft) {
        setActiveTab(tab);
        return;
      }
      // Warn if schema wasn't created by the builder
      const schema = draft.jsonSchema as Record<string, unknown>;
      if (!schema['x-flowstile-builder']) {
        const ok = window.confirm(
          'This schema may contain constructs the visual builder can\'t represent. ' +
          'Switch anyway? Unsupported constructs will be preserved but not editable.'
        );
        if (!ok) return;
      }
      try {
        const fields = fromSchema({
          jsonSchema: draft.jsonSchema,
          uiSchema: draft.uiSchema,
          visibilityRules: draft.visibilityRules ?? {},
        });
        history.reset(fields);
        setSelectedFieldId(null);
      } catch {
        setError('Cannot switch to Designer: invalid schema JSON.');
        return;
      }
    }

    setActiveTab(tab);
  }, [activeTab, history, draft]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeTab !== 'designer') return;
      const mod = e.ctrlKey || e.metaKey;

      // Undo/Redo
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
        return;
      }
      if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'Z')) {
        e.preventDefault();
        history.redo();
        return;
      }

      // Delete selected field
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFieldId && !mod) {
        // Don't intercept if user is typing in an input
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        const next = history.state.filter((f) => f.id !== selectedFieldId);
        if (next.length !== history.state.length) {
          history.push(next);
          setSelectedFieldId(null);
        }
        return;
      }

      // Alt+Arrow to reorder selected field
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedFieldId) {
        e.preventDefault();
        const idx = history.state.findIndex((f) => f.id === selectedFieldId);
        if (idx === -1) return;
        const newIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
        if (newIdx < 0 || newIdx >= history.state.length) return;
        const reordered = [...history.state];
        [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
        history.push(reordered);
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, history, selectedFieldId]);

  // ── Sidebar actions ──────────────────────────────────────────────────────
  const handleSelect = (code: string) => {
    setSelectedCode(code);
    setActiveTab('designer');
    setSelectedFieldId(null);
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

  // ── Save / Publish ───────────────────────────────────────────────────────
  const handleSaveDraft = async () => {
    if (!selectedCode || !draft) return;
    setBusy(true);
    setError(null);
    try {
      // Sync visual builder state into draft before saving
      const schemaOut = activeTab === 'designer' ? toSchema(history.state) : null;
      const baseSchema = schemaOut ? schemaOut.jsonSchema : draft.jsonSchema;
      const payload = schemaOut
        ? {
          jsonSchema: withOutcomeEnum(schemaOut.jsonSchema, draft),
          uiSchema: schemaOut.uiSchema,
          visibilityRules: schemaOut.visibilityRules,
          formMessages: draft.formMessages,
          outcomes: draft.outcomes,
          outcomeKey: draft.outcomeKey,
        }
        : {
          jsonSchema: withOutcomeEnum(baseSchema, draft),
          uiSchema: draft.uiSchema,
          visibilityRules: draft.visibilityRules,
          formMessages: draft.formMessages,
          outcomes: draft.outcomes,
          outcomeKey: draft.outcomeKey,
        };
      const saved = await updateDraft(selectedCode, payload);
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
      // Save draft first
      await handleSaveDraft();
      await publishForm(selectedCode);
      const vs = await getFormVersions(selectedCode);
      setPublishedVersions(vs.filter((v) => v.status === 'published'));
      setDraft(null);
      history.reset([]);
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
      await reloadForms();
      const fields = fromSchema({
        jsonSchema: saved.jsonSchema,
        uiSchema: saved.uiSchema,
        visibilityRules: saved.visibilityRules ?? {},
      });
      history.reset(fields);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const latestPublished = publishedVersions[publishedVersions.length - 1];
  const versionLabel = latestPublished
    ? `v${latestPublished.version} published — editing draft`
    : 'Draft (unpublished)';

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
          <DesignerToolbar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            formCode={selectedCode}
            versionLabel={versionLabel}
            busy={busy}
            onSave={handleSaveDraft}
            onPublish={handlePublish}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={history.undo}
            onRedo={history.redo}
          />
          <div className="designer-content">
            {activeTab === 'designer' && (
              <VisualBuilder
                fields={history.state}
                onChange={history.push}
                selectedId={selectedFieldId}
                onSelect={setSelectedFieldId}
                hasPublishedVersions={publishedVersions.length > 0}
              />
            )}
            {activeTab === 'source' && (
              <div className="editor-preview-split">
                <FormEditor
                  form={draft}
                  onChange={(updated) => setDraft((d) => d ? { ...d, ...updated } : d)}
                />
              </div>
            )}
            {activeTab === 'outcomes' && (
              <OutcomesPanel
                outcomes={draft.outcomes}
                outcomeKey={draft.outcomeKey}
                onChange={({ outcomes, outcomeKey }) =>
                  setDraft((d) => (d ? { ...d, outcomes, outcomeKey } : d))
                }
              />
            )}
            {activeTab === 'preview' && (
              <div className="preview-full">
                <FormPreview form={draft} />
              </div>
            )}
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
