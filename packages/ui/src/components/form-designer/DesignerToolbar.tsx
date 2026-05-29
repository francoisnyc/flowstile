import React from 'react';

export type DesignerTab = 'designer' | 'source' | 'outcomes' | 'preview';

interface Props {
  activeTab: DesignerTab;
  onTabChange: (tab: DesignerTab) => void;
  formCode: string;
  versionLabel: string;
  busy: boolean;
  onSave: () => void;
  onPublish: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const TABS: { key: DesignerTab; label: string }[] = [
  { key: 'designer', label: 'Designer' },
  { key: 'source', label: 'Source' },
  { key: 'outcomes', label: 'Outcomes' },
  { key: 'preview', label: 'Preview' },
];

export default function DesignerToolbar({
  activeTab, onTabChange, formCode, versionLabel,
  busy, onSave, onPublish,
  canUndo, canRedo, onUndo, onRedo,
}: Props) {
  return (
    <div className="designer-toolbar">
      <span className="form-code">{formCode}</span>
      <span className="version-label">{versionLabel}</span>

      <div className="designer-tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={`tab ${activeTab === key ? 'active' : ''}`}
            onClick={() => onTabChange(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="designer-actions">
        {activeTab === 'designer' && (
          <>
            <button className="icon-btn" disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)">↩</button>
            <button className="icon-btn" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)">↪</button>
          </>
        )}
        <button disabled={busy} onClick={onSave}>Save draft</button>
        <button className="primary" disabled={busy} onClick={onPublish}>Publish</button>
      </div>
    </div>
  );
}
