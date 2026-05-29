import React from 'react';
import type { FieldDefinition, CompoundVisibility } from './types.js';
import VisibilityEditor from './VisibilityEditor.js';

interface Props {
  field: FieldDefinition | null;
  allFields: FieldDefinition[];
  hasPublishedVersions: boolean;
  onChange: (updated: FieldDefinition) => void;
  onDelete: (id: string) => void;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="props-section-header">{children}</div>;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="props-field">
      <label className="props-label">{label}</label>
      {children}
    </div>
  );
}

export default function PropertiesPanel({ field, allFields, hasPublishedVersions, onChange, onDelete }: Props) {
  if (!field) {
    return (
      <div className="properties-panel">
        <p className="props-empty">Select a field to edit its properties</p>
      </div>
    );
  }

  if (field.type === 'unsupported') {
    return (
      <div className="properties-panel">
        <p className="props-empty">This field type cannot be edited here. Use the Source tab to modify it.</p>
      </div>
    );
  }

  const isSection = field.type === 'section';
  const isBoolean = field.type === 'boolean';

  function patch(updates: Partial<FieldDefinition>) {
    onChange({ ...field, ...updates } as FieldDefinition);
  }

  function patchOptions(updates: { placeholder?: string; helpText?: string }) {
    const currentOptions = (field as { options?: { placeholder?: string; helpText?: string } }).options ?? {};
    patch({ options: { ...currentOptions, ...updates } } as Partial<FieldDefinition>);
  }

  function handleKeyChange(raw: string) {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    patch({ key: cleaned } as Partial<FieldDefinition>);
  }

  function handleVisibilityChange(v: CompoundVisibility | undefined) {
    patch({ visibility: v } as Partial<FieldDefinition>);
  }

  const options = (field as { options?: { placeholder?: string; helpText?: string } }).options;

  return (
    <div className="properties-panel">
      <SectionHeader>Field Properties</SectionHeader>

      {/* Label */}
      <FieldRow label="Label">
        <input
          type="text"
          value={field.label}
          onChange={(e) => patch({ label: e.target.value } as Partial<FieldDefinition>)}
        />
      </FieldRow>

      {/* Key */}
      <FieldRow label="Key">
        <input
          type="text"
          value={field.key}
          onChange={(e) => handleKeyChange(e.target.value)}
        />
        {hasPublishedVersions && (
          <span className="props-warning props-hint">
            Warning: changing the key on a published form may break existing data.
          </span>
        )}
      </FieldRow>

      {/* Required (not for sections) */}
      {!isSection && (
        <label className="props-checkbox">
          <input
            type="checkbox"
            checked={(field as { required: boolean }).required}
            onChange={(e) => patch({ required: e.target.checked } as Partial<FieldDefinition>)}
          />
          Required
        </label>
      )}

      {/* Type-specific validation */}
      {(field.type === 'text' || field.type === 'textarea') && (
        <>
          <SectionHeader>Validation</SectionHeader>
          <FieldRow label="Min length">
            <input
              type="number"
              value={(field as { minLength?: number }).minLength ?? ''}
              onChange={(e) => patch({ minLength: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<FieldDefinition>)}
            />
          </FieldRow>
          <FieldRow label="Max length">
            <input
              type="number"
              value={(field as { maxLength?: number }).maxLength ?? ''}
              onChange={(e) => patch({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<FieldDefinition>)}
            />
          </FieldRow>
        </>
      )}

      {(field.type === 'text' || field.type === 'email') && (
        <>
          {field.type === 'text' && <></> /* already rendered Validation header above for text */}
          {field.type === 'email' && <SectionHeader>Validation</SectionHeader>}
          <FieldRow label="Pattern (regex)">
            <input
              type="text"
              value={(field as { pattern?: string }).pattern ?? ''}
              onChange={(e) => patch({ pattern: e.target.value || undefined } as Partial<FieldDefinition>)}
            />
          </FieldRow>
        </>
      )}

      {field.type === 'number' && (
        <>
          <SectionHeader>Validation</SectionHeader>
          <FieldRow label="Minimum">
            <input
              type="number"
              value={(field as { minimum?: number }).minimum ?? ''}
              onChange={(e) => patch({ minimum: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<FieldDefinition>)}
            />
          </FieldRow>
          <FieldRow label="Maximum">
            <input
              type="number"
              value={(field as { maximum?: number }).maximum ?? ''}
              onChange={(e) => patch({ maximum: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<FieldDefinition>)}
            />
          </FieldRow>
        </>
      )}

      {field.type === 'select' && (
        <>
          <SectionHeader>Options</SectionHeader>
          <FieldRow label="Values (one per line)">
            <textarea
              rows={4}
              value={(field as { enumValues: string[] }).enumValues.join('\n')}
              onChange={(e) => {
                const enumValues = e.target.value.split('\n').map((s) => s.trimEnd()).filter(Boolean);
                patch({ enumValues } as Partial<FieldDefinition>);
              }}
            />
          </FieldRow>
        </>
      )}

      {field.type === 'file' && (
        <>
          <SectionHeader>File Upload</SectionHeader>
          <label className="props-checkbox">
            <input
              type="checkbox"
              checked={(field as { multiple?: boolean }).multiple ?? false}
              onChange={(e) => patch({ multiple: e.target.checked } as Partial<FieldDefinition>)}
            />
            Allow multiple files
          </label>
          <FieldRow label="Accepted types (comma-separated)">
            <input
              type="text"
              placeholder="image/*, application/pdf"
              value={((field as { accept?: string[] }).accept ?? []).join(', ')}
              onChange={(e) =>
                patch({
                  accept: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                } as Partial<FieldDefinition>)
              }
            />
          </FieldRow>
          <FieldRow label="Max file size (bytes)">
            <input
              type="number"
              value={(field as { maxSize?: number }).maxSize ?? ''}
              onChange={(e) =>
                patch({ maxSize: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<FieldDefinition>)
              }
            />
          </FieldRow>
        </>
      )}

      {/* Placeholder and helpText (not for section or boolean or file) */}
      {!isSection && !isBoolean && field.type !== 'file' && (
        <>
          <SectionHeader>Display</SectionHeader>
          <FieldRow label="Placeholder">
            <input
              type="text"
              value={options?.placeholder ?? ''}
              onChange={(e) => patchOptions({ placeholder: e.target.value || undefined })}
            />
          </FieldRow>
          <FieldRow label="Help text">
            <input
              type="text"
              value={options?.helpText ?? ''}
              onChange={(e) => patchOptions({ helpText: e.target.value || undefined })}
            />
          </FieldRow>
        </>
      )}

      {/* Visibility */}
      <SectionHeader>Visibility</SectionHeader>
      <VisibilityEditor
        visibility={field.visibility}
        allFields={allFields}
        currentKey={field.key}
        onChange={handleVisibilityChange}
      />

      {/* Delete */}
      <div className="props-delete-section">
        <button
          type="button"
          className="delete-field-btn"
          onClick={() => onDelete(field.id)}
        >
          Delete field
        </button>
      </div>
    </div>
  );
}
