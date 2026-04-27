import React, { useState } from 'react';
import Editor from '@monaco-editor/react';
import type { FormDefinition } from '../types.js';

type Tab = 'jsonSchema' | 'uiSchema' | 'visibilityRules' | 'formMessages';

const TABS: { key: Tab; label: string }[] = [
  { key: 'jsonSchema', label: 'Schema' },
  { key: 'uiSchema', label: 'UI Schema' },
  { key: 'visibilityRules', label: 'Visibility Rules' },
  { key: 'formMessages', label: 'Messages' },
];

interface Props {
  form: FormDefinition;
  onChange: (updated: Pick<FormDefinition, 'jsonSchema' | 'uiSchema' | 'visibilityRules' | 'formMessages'>) => void;
}

export default function FormEditor({ form, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('jsonSchema');
  const [parseError, setParseError] = useState<string | null>(null);

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined) return;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      setParseError(null);
      onChange({ ...form, [tab]: parsed });
    } catch {
      setParseError('Invalid JSON');
    }
  };

  return (
    <div className="form-editor">
      <div className="tab-bar">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => { setTab(key); setParseError(null); }}
          >
            {label}
          </button>
        ))}
        {parseError && <span className="parse-error">⚠ {parseError}</span>}
      </div>
      <Editor
        height="100%"
        language="json"
        value={JSON.stringify(form[tab], null, 2)}
        onChange={handleEditorChange}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          tabSize: 2,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
    </div>
  );
}
