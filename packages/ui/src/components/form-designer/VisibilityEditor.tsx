import React from 'react';
import type { CompoundVisibility, VisibilityCondition, FieldDefinition } from './types.js';

interface Props {
  visibility: CompoundVisibility | undefined;
  allFields: FieldDefinition[];
  currentKey: string;
  onChange: (v: CompoundVisibility | undefined) => void;
}

const OPS = [
  { value: 'equals', label: '=' },
  { value: 'notEquals', label: '≠' },
  { value: 'greaterThan', label: '>' },
  { value: 'lessThan', label: '<' },
  { value: 'exists', label: 'exists' },
  { value: 'notExists', label: 'not exists' },
] as const;

type OpValue = typeof OPS[number]['value'];

function isValuelessOp(op: string): boolean {
  return op === 'exists' || op === 'notExists';
}

export default function VisibilityEditor({ visibility, allFields, currentKey, onChange }: Props) {
  const availableFields = allFields.filter(
    (f) => f.key !== currentKey && f.type !== 'section',
  );

  function handleToggleOperator() {
    if (!visibility) return;
    onChange({
      ...visibility,
      operator: visibility.operator === 'and' ? 'or' : 'and',
    });
  }

  function handleAddCondition() {
    const firstField = availableFields[0];
    const newCondition: VisibilityCondition = {
      field: firstField ? firstField.key : '',
      op: 'equals',
      value: '',
    };
    if (!visibility) {
      onChange({ operator: 'and', conditions: [newCondition] });
    } else {
      onChange({ ...visibility, conditions: [...visibility.conditions, newCondition] });
    }
  }

  function handleRemoveCondition(index: number) {
    if (!visibility) return;
    const next = visibility.conditions.filter((_, i) => i !== index);
    if (next.length === 0) {
      onChange(undefined);
    } else {
      onChange({ ...visibility, conditions: next });
    }
  }

  function handleConditionChange(index: number, patch: Partial<VisibilityCondition>) {
    if (!visibility) return;
    const next = visibility.conditions.map((c, i) => {
      if (i !== index) return c;
      const updated = { ...c, ...patch };
      if (isValuelessOp(updated.op)) {
        delete updated.value;
      }
      return updated;
    });
    onChange({ ...visibility, conditions: next });
  }

  const conditions = visibility?.conditions ?? [];

  return (
    <div className="visibility-editor">
      {conditions.length > 1 && (
        <button className="operator-toggle" type="button" onClick={handleToggleOperator}>
          {visibility!.operator.toUpperCase()}
        </button>
      )}
      {conditions.map((cond, i) => (
        <div key={i} className="visibility-row">
          <select
            value={cond.field}
            onChange={(e) => handleConditionChange(i, { field: e.target.value })}
          >
            {availableFields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label || f.key}
              </option>
            ))}
            {!availableFields.some((f) => f.key === cond.field) && (
              <option value={cond.field}>{cond.field}</option>
            )}
          </select>
          <select
            value={cond.op}
            onChange={(e) => handleConditionChange(i, { op: e.target.value as OpValue })}
          >
            {OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          {!isValuelessOp(cond.op) && (
            <input
              type="text"
              value={cond.value != null ? String(cond.value) : ''}
              onChange={(e) => handleConditionChange(i, { value: e.target.value })}
            />
          )}
          <button
            type="button"
            className="remove-cond"
            onClick={() => handleRemoveCondition(i)}
            title="Remove condition"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="add-cond-btn" onClick={handleAddCondition}>
        + Add condition
      </button>
    </div>
  );
}
