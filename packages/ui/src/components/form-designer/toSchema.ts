import type {
  FieldDefinition,
  TextField,
  NumberField,
  TextareaField,
  EmailField,
  SelectField,
  FileField,
  SectionField,
  RepeatField,
  UnsupportedField,
  SchemaOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// JSON Schema property builders
// ---------------------------------------------------------------------------

function textToJsonSchema(field: TextField): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: 'string' };
  if (field.minLength !== undefined) prop.minLength = field.minLength;
  if (field.maxLength !== undefined) prop.maxLength = field.maxLength;
  if (field.pattern !== undefined) prop.pattern = field.pattern;
  return prop;
}

function numberToJsonSchema(field: NumberField): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: 'number' };
  if (field.minimum !== undefined) prop.minimum = field.minimum;
  if (field.maximum !== undefined) prop.maximum = field.maximum;
  return prop;
}

function textareaToJsonSchema(field: TextareaField): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: 'string' };
  if (field.minLength !== undefined) prop.minLength = field.minLength;
  if (field.maxLength !== undefined) prop.maxLength = field.maxLength;
  return prop;
}

function emailToJsonSchema(field: EmailField): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: 'string', format: 'email' };
  if (field.pattern !== undefined) prop.pattern = field.pattern;
  return prop;
}

function selectToJsonSchema(field: SelectField): Record<string, unknown> {
  return { type: 'string', enum: field.enumValues };
}

function fileToJsonSchema(field: FileField): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (field.multiple !== undefined) cfg.multiple = field.multiple;
  if (field.accept && field.accept.length > 0) cfg.accept = field.accept;
  if (field.maxSize !== undefined) cfg.maxSize = field.maxSize;
  // For multiple files the stored value is an array; single is an object.
  // No top-level `type` constraint — validateAndCollectReferences handles shape validation.
  return { 'x-flowstile-attachment': cfg };
}

// ---------------------------------------------------------------------------
// UISchema element builders
// ---------------------------------------------------------------------------

interface UiElement {
  type: string;
  scope?: string;
  label?: string;
  options?: Record<string, unknown>;
  elements?: UiElement[];
}

function buildBaseUiOptions(
  field: { options?: { placeholder?: string; helpText?: string } },
  extra: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const opts: Record<string, unknown> = { ...extra };
  if (field.options?.placeholder !== undefined) opts.placeholder = field.options.placeholder;
  if (field.options?.helpText !== undefined) opts.helpText = field.options.helpText;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function fieldToUiElement(field: FieldDefinition): UiElement | null {
  switch (field.type) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'select':
    case 'date':
    case 'email': {
      const el: UiElement = {
        type: 'Control',
        scope: `#/properties/${field.key}`,
        label: field.label,
      };
      const opts = buildBaseUiOptions(field);
      if (opts) el.options = opts;
      return el;
    }

    case 'textarea': {
      const el: UiElement = {
        type: 'Control',
        scope: `#/properties/${field.key}`,
        label: field.label,
      };
      const opts = buildBaseUiOptions(field, { multi: true });
      el.options = opts!; // always has at least { multi: true }
      return el;
    }

    case 'file': {
      // File fields are rendered by FileField, not JSON Forms.
      // Emit a uiSchema element with scope so visibility filtering still works.
      return {
        type: 'Control',
        scope: `#/properties/${field.key}`,
        label: field.label,
      };
    }

    case 'section': {
      const childElements = buildUiElements(field.children);
      const el: UiElement = {
        type: 'Group',
        label: field.label,
        elements: childElements,
      };
      const opts = buildBaseUiOptions(field);
      if (opts) el.options = opts;
      return el;
    }

    case 'repeat': {
      const el: UiElement = {
        type: 'Control',
        scope: `#/properties/${field.key}`,
        label: field.label,
      };
      const opts = buildBaseUiOptions(field);
      if (opts) el.options = opts;
      return el;
    }

    case 'unsupported': {
      if (field.uiSchemaFragment !== undefined) {
        return field.uiSchemaFragment as UiElement;
      }
      return null;
    }
  }
}

function buildUiElements(fields: FieldDefinition[]): UiElement[] {
  const elements: UiElement[] = [];
  for (const field of fields) {
    const el = fieldToUiElement(field);
    if (el !== null) elements.push(el);
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Core collector: processes fields into properties, required, visibility
// ---------------------------------------------------------------------------

interface CollectResult {
  properties: Record<string, unknown>;
  required: string[];
  visibilityRules: Record<string, unknown>;
}

function collectFields(fields: FieldDefinition[]): CollectResult {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const visibilityRules: Record<string, unknown> = {};

  for (const field of fields) {
    // Collect visibility rules (all field types except section don't have required)
    if ('visibility' in field && field.visibility !== undefined) {
      visibilityRules[field.key] = field.visibility;
    }

    switch (field.type) {
      case 'text':
        properties[field.key] = textToJsonSchema(field);
        if (field.required) required.push(field.key);
        break;

      case 'number':
        properties[field.key] = numberToJsonSchema(field);
        if (field.required) required.push(field.key);
        break;

      case 'boolean':
        properties[field.key] = { type: 'boolean' };
        if (field.required) required.push(field.key);
        break;

      case 'select':
        properties[field.key] = selectToJsonSchema(field);
        if (field.required) required.push(field.key);
        break;

      case 'textarea':
        properties[field.key] = textareaToJsonSchema(field);
        if (field.required) required.push(field.key);
        break;

      case 'date':
        properties[field.key] = { type: 'string', format: 'date' };
        if (field.required) required.push(field.key);
        break;

      case 'email':
        properties[field.key] = emailToJsonSchema(field);
        if (field.required) required.push(field.key);
        break;

      case 'file':
        properties[field.key] = fileToJsonSchema(field);
        // File fields are never "required" in the JSON Schema sense — presence is
        // validated separately by validateAndCollectReferences.
        break;

      case 'section': {
        // Hoist children into top-level properties
        const childResult = collectFields(field.children);
        Object.assign(properties, childResult.properties);
        required.push(...childResult.required);
        Object.assign(visibilityRules, childResult.visibilityRules);
        break;
      }

      case 'repeat': {
        const childResult = collectFields(field.children);
        const itemSchema: Record<string, unknown> = {
          type: 'object',
          properties: childResult.properties,
        };
        if (childResult.required.length > 0) itemSchema.required = childResult.required;
        properties[field.key] = { type: 'array', items: itemSchema };
        // Collect child visibility under their own keys
        Object.assign(visibilityRules, childResult.visibilityRules);
        if (field.required) required.push(field.key);
        break;
      }

      case 'unsupported':
        properties[field.key] = field.jsonSchemaFragment as unknown;
        if (field.required) required.push(field.key);
        break;
    }
  }

  return { properties, required, visibilityRules };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function toSchema(fields: FieldDefinition[]): SchemaOutput {
  const { properties, required, visibilityRules } = collectFields(fields);

  const jsonSchema: Record<string, unknown> = {
    type: 'object',
    'x-flowstile-builder': true,
    properties,
  };
  if (required.length > 0) jsonSchema.required = required;

  const uiSchema: Record<string, unknown> = {
    type: 'VerticalLayout',
    elements: buildUiElements(fields),
  };

  return { jsonSchema, uiSchema, visibilityRules };
}
