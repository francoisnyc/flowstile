import React from 'react';
import type { FormOutcome, OutcomeStyle } from '../../types.js';

interface Props {
  outcomes: FormOutcome[] | null;
  outcomeKey: string | null;
  onChange: (next: { outcomes: FormOutcome[] | null; outcomeKey: string | null }) => void;
}

const STYLES: OutcomeStyle[] = ['primary', 'secondary', 'danger'];

// Edits a form's declarative completion buttons. Each outcome writes its
// `value` into submissionData[outcomeKey] and completes the task. No outcomes
// → the task shows a single generic Complete button.
export default function OutcomesPanel({ outcomes, outcomeKey, onChange }: Props) {
  const rows = outcomes ?? [];

  const update = (next: FormOutcome[], key = outcomeKey) =>
    onChange({ outcomes: next.length > 0 ? next : null, outcomeKey: key });

  const setRow = (idx: number, patch: Partial<FormOutcome>) => {
    update(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () =>
    update([...rows, { value: '', label: '', style: 'secondary' }], outcomeKey ?? 'DECISION');

  const removeRow = (idx: number) => update(rows.filter((_, i) => i !== idx));

  return (
    <div className="outcomes-panel" style={{ padding: 16, maxWidth: 720 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Outcome buttons replace the generic Complete button. Each button completes
        the task and writes its value into the field named below. Leave empty for a
        single Complete button.
      </p>

      <label style={{ display: 'block', marginBottom: 16 }}>
        Outcome field key
        <input
          style={{ display: 'block', marginTop: 4, width: 240 }}
          placeholder="DECISION"
          value={outcomeKey ?? ''}
          onChange={(e) => update(rows, e.target.value || null)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          Defaults to <code>DECISION</code>. This becomes a string enum in the form schema.
        </span>
      </label>

      <table className="outcomes-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Value</th>
            <th style={{ textAlign: 'left' }}>Label</th>
            <th style={{ textAlign: 'left' }}>Style</th>
            <th style={{ textAlign: 'left' }}>Required fields (comma-separated)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx}>
              <td>
                <input
                  value={row.value}
                  placeholder="approved"
                  onChange={(e) => setRow(idx, { value: e.target.value })}
                />
              </td>
              <td>
                <input
                  value={row.label}
                  placeholder="Approve"
                  onChange={(e) => setRow(idx, { label: e.target.value })}
                />
              </td>
              <td>
                <select
                  value={row.style ?? 'secondary'}
                  onChange={(e) => setRow(idx, { style: e.target.value as OutcomeStyle })}
                >
                  {STYLES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  value={(row.requireFields ?? []).join(', ')}
                  placeholder="NOTES"
                  onChange={(e) =>
                    setRow(idx, {
                      requireFields: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </td>
              <td>
                <button className="icon-btn" title="Remove" onClick={() => removeRow(idx)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button style={{ marginTop: 12 }} onClick={addRow}>+ Add outcome</button>
    </div>
  );
}
