import React, { useState } from 'react';
import { JsonForms } from '@jsonforms/react';
import { vanillaRenderers, vanillaCells } from '@jsonforms/vanilla-renderers';
import type { UISchemaElement } from '@jsonforms/core';
import type { FormDefinition } from '../types.js';

interface Props {
  form: FormDefinition;
}

export default function FormPreview({ form }: Props) {
  const [data, setData] = useState<Record<string, unknown>>({});

  return (
    <div className="form-preview">
      <div className="preview-header">Preview</div>
      <div className="preview-body">
        <JsonForms
          schema={form.jsonSchema}
          uischema={form.uiSchema as unknown as UISchemaElement}
          data={data}
          renderers={vanillaRenderers}
          cells={vanillaCells}
          onChange={({ data: d }) => setData(d as Record<string, unknown>)}
        />
      </div>
    </div>
  );
}
