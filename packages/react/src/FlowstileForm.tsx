import React from 'react';
import { JsonForms } from '@jsonforms/react';
import { vanillaRenderers, vanillaCells } from '@jsonforms/vanilla-renderers';
import type { UISchemaElement, JsonSchema } from '@jsonforms/core';

export interface FlowstileFormProps {
  schema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  readOnly?: boolean;
  validationErrors?: Record<string, string[]>;
}

export function FlowstileForm({
  schema,
  uiSchema,
  data,
  onChange,
  readOnly = false,
  validationErrors,
}: FlowstileFormProps) {
  return (
    <div className="flowstile-form">
      <JsonForms
        schema={schema as JsonSchema}
        uischema={uiSchema as unknown as UISchemaElement}
        data={data}
        renderers={vanillaRenderers}
        cells={vanillaCells}
        onChange={({ data: newData }) => onChange(newData as Record<string, unknown>)}
        readonly={readOnly}
      />
      {validationErrors && Object.keys(validationErrors).length > 0 && (
        <div className="flowstile-form-errors" role="alert">
          {Object.entries(validationErrors).map(([path, messages]) => (
            <div key={path} className="flowstile-form-error">
              <strong>{path}:</strong> {messages.join(', ')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
