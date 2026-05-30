import React, { useState, useEffect } from 'react';
import { JsonForms } from '@jsonforms/react';
import { vanillaRenderers, vanillaCells } from '@jsonforms/vanilla-renderers';
import type { UISchemaElement } from '@jsonforms/core';
import type { ProcessSummary, FormDefinition } from '../types.js';
import { listProcesses, getPublishedForm, startCase } from '../api/client.js';

interface Props {
  onStarted: (caseId: string) => void;
  onClose: () => void;
}

type Step = 'pick' | 'fill';

export default function StartCaseModal({ onStarted, onClose }: Props) {
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [loadingProcesses, setLoadingProcesses] = useState(true);
  const [selected, setSelected] = useState<ProcessSummary | null>(null);
  const [form, setForm] = useState<FormDefinition | null>(null);
  const [loadingForm, setLoadingForm] = useState(false);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState<Step>('pick');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable per-attempt key so a double-submit (or retry) resolves to one case.
  const [idempotencyKey, setIdempotencyKey] = useState('');

  useEffect(() => {
    listProcesses({ status: 'active', limit: '200' })
      .then((page) => setProcesses(page.items.filter((p) => p.workflowType && p.taskQueue)))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingProcesses(false));
  }, []);

  const pickProcess = async (p: ProcessSummary) => {
    setSelected(p);
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    if (p.startFormCode) {
      setLoadingForm(true);
      try {
        const f = await getPublishedForm(p.startFormCode);
        setForm(f ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load form');
      } finally {
        setLoadingForm(false);
      }
    } else {
      setForm(null);
    }
    setFormData({});
    setStep('fill');
  };

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startCase(selected.id, formData, idempotencyKey);
      onStarted(result.caseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start case');
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{step === 'pick' ? 'Start new case' : `Start: ${selected?.name}`}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <p className="form-error">{error}</p>}

        {step === 'pick' && (
          <div className="modal-body">
            {loadingProcesses ? (
              <p className="empty">Loading processes…</p>
            ) : processes.length === 0 ? (
              <p className="empty">No startable processes available.</p>
            ) : (
              <ul className="process-pick-list">
                {processes.map((p) => (
                  <li key={p.id}>
                    <button className="process-pick-item" onClick={() => pickProcess(p)}>
                      <span className="process-pick-name">{p.name}</span>
                      {p.startFormCode && (
                        <span className="process-pick-hint">Has start form</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 'fill' && (
          <>
            <div className="modal-body">
              {loadingForm ? (
                <p className="empty">Loading form…</p>
              ) : form ? (
                <JsonForms
                  schema={form.jsonSchema}
                  uischema={form.uiSchema as unknown as UISchemaElement | undefined}
                  data={formData}
                  renderers={vanillaRenderers}
                  cells={vanillaCells}
                  onChange={({ data }) => setFormData(data as Record<string, unknown>)}
                />
              ) : (
                <p className="empty">No start form — click Submit to start immediately.</p>
              )}
            </div>
            <div className="modal-footer">
              <button className="secondary" onClick={() => setStep('pick')} disabled={submitting}>
                Back
              </button>
              <button className="primary" onClick={submit} disabled={submitting || loadingForm}>
                {submitting ? 'Starting…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
