import type {
  FieldDefinition,
  TextField,
  NumberField,
  BooleanField,
  SelectField,
  TextareaField,
  DateField,
  EmailField,
  FileField,
  SectionField,
  RepeatField,
  UnsupportedField,
  CompoundVisibility,
  SchemaOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal types mirroring UISchema shape
// ---------------------------------------------------------------------------

interface UiControl {
  type: 'Control';
  scope: string;
  label?: string;
  options?: Record<string, unknown>;
}

interface UiGroup {
  type: 'Group';
  label?: string;
  options?: Record<string, unknown>;
  elements?: UiElement[];
}

type UiElement = UiControl | UiGroup | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractKey(scope: string): string {
  // scope is like "#/properties/KEY"
  const parts = scope.split('/');
  return parts[parts.length - 1];
}

function baseOptions(
  uiOptions: Record<string, unknown> | undefined,
): { placeholder?: string; helpText?: string } | undefined {
  if (!uiOptions) return undefined;
  const result: { placeholder?: string; helpText?: string } = {};
  if (typeof uiOptions.placeholder === 'string') result.placeholder = uiOptions.placeholder;
  if (typeof uiOptions.helpText === 'string') result.helpText = uiOptions.helpText;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Infer FieldDefinition from a JSON Schema property + UISchema element options. */
function inferFieldType(
  key: string,
  label: string,
  prop: Record<string, unknown>,
  uiOptions: Record<string, unknown> | undefined,
  required: boolean,
  visibility: CompoundVisibility | undefined,
  uiSchemaFragment?: unknown,
): FieldDefinition {
  const opts = baseOptions(uiOptions);
  const base = { key, label, required, ...(visibility ? { visibility } : {}), ...(opts ? { options: opts } : {}) };

  // Attachment field (x-flowstile-attachment vendor extension)
  if ('x-flowstile-attachment' in prop) {
    const cfg = (prop['x-flowstile-attachment'] ?? {}) as Record<string, unknown>;
    const field: FileField = {
      id: crypto.randomUUID(),
      ...base,
      type: 'file',
      ...(cfg.multiple !== undefined ? { multiple: cfg.multiple as boolean } : {}),
      ...(cfg.accept !== undefined ? { accept: cfg.accept as string[] } : {}),
      ...(cfg.maxSize !== undefined ? { maxSize: cfg.maxSize as number } : {}),
    };
    return field;
  }

  // Unknown constructs → unsupported
  if ('oneOf' in prop || 'anyOf' in prop || 'allOf' in prop || '$ref' in prop) {
    const field: UnsupportedField = {
      id: crypto.randomUUID(),
      ...base,
      type: 'unsupported',
      jsonSchemaFragment: prop,
      ...(uiSchemaFragment !== undefined ? { uiSchemaFragment } : {}),
    };
    return field;
  }

  const type = prop.type as string | undefined;
  const format = prop.format as string | undefined;
  const enumValues = prop.enum as string[] | undefined;

  // Boolean
  if (type === 'boolean') {
    const field: BooleanField = { id: crypto.randomUUID(), ...base, type: 'boolean' };
    return field;
  }

  // Number / integer
  if (type === 'number' || type === 'integer') {
    const field: NumberField = {
      id: crypto.randomUUID(),
      ...base,
      type: 'number',
      ...(prop.minimum !== undefined ? { minimum: prop.minimum as number } : {}),
      ...(prop.maximum !== undefined ? { maximum: prop.maximum as number } : {}),
    };
    return field;
  }

  // Array → handled before reaching here (repeat); if we get here it's unsupported
  if (type === 'array') {
    const field: UnsupportedField = {
      id: crypto.randomUUID(),
      ...base,
      type: 'unsupported',
      jsonSchemaFragment: prop,
      ...(uiSchemaFragment !== undefined ? { uiSchemaFragment } : {}),
    };
    return field;
  }

  // String variants
  if (type === 'string' || type === undefined) {
    // Select: string with enum
    if (enumValues) {
      const field: SelectField = {
        id: crypto.randomUUID(),
        ...base,
        type: 'select',
        enumValues,
      };
      return field;
    }

    // Date
    if (format === 'date') {
      const field: DateField = { id: crypto.randomUUID(), ...base, type: 'date' };
      return field;
    }

    // Email
    if (format === 'email') {
      const field: EmailField = {
        id: crypto.randomUUID(),
        ...base,
        type: 'email',
        ...(prop.pattern !== undefined ? { pattern: prop.pattern as string } : {}),
      };
      return field;
    }

    // Textarea: options.multi === true in UISchema
    if (uiOptions?.multi === true) {
      const field: TextareaField = {
        id: crypto.randomUUID(),
        ...base,
        type: 'textarea',
        ...(prop.minLength !== undefined ? { minLength: prop.minLength as number } : {}),
        ...(prop.maxLength !== undefined ? { maxLength: prop.maxLength as number } : {}),
      };
      return field;
    }

    // Plain text
    const field: TextField = {
      id: crypto.randomUUID(),
      ...base,
      type: 'text',
      ...(prop.minLength !== undefined ? { minLength: prop.minLength as number } : {}),
      ...(prop.maxLength !== undefined ? { maxLength: prop.maxLength as number } : {}),
      ...(prop.pattern !== undefined ? { pattern: prop.pattern as string } : {}),
    };
    return field;
  }

  // Fallback: unsupported
  const field: UnsupportedField = {
    id: crypto.randomUUID(),
    ...base,
    type: 'unsupported',
    jsonSchemaFragment: prop,
    ...(uiSchemaFragment !== undefined ? { uiSchemaFragment } : {}),
  };
  return field;
}

// ---------------------------------------------------------------------------
// Walk UISchema elements and produce FieldDefinition[]
// ---------------------------------------------------------------------------

function walkElements(
  elements: UiElement[],
  properties: Record<string, unknown>,
  requiredSet: Set<string>,
  visibilityRules: Record<string, unknown>,
  visitedKeys: Set<string>,
): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  for (const el of elements) {
    const elTyped = el as { type?: string };

    if (elTyped.type === 'Group') {
      const group = el as UiGroup;
      const children = walkElements(
        group.elements ?? [],
        properties,
        requiredSet,
        visibilityRules,
        visitedKeys,
      );
      const sectionOpts = baseOptions(group.options);
      const section: SectionField = {
        id: crypto.randomUUID(),
        key: '', // sections don't have a property key
        label: group.label ?? '',
        type: 'section',
        children,
        ...(sectionOpts ? { options: sectionOpts } : {}),
      };
      fields.push(section);
      continue;
    }

    if (elTyped.type === 'Control') {
      const control = el as UiControl;
      const key = extractKey(control.scope);
      visitedKeys.add(key);

      const prop = properties[key] as Record<string, unknown> | undefined;
      const uiOptions = control.options;
      const required = requiredSet.has(key);
      const visibility = visibilityRules[key] as CompoundVisibility | undefined;
      const label = control.label ?? key;

      if (!prop) {
        // Key referenced in UISchema but not in properties — unsupported
        const field: UnsupportedField = {
          id: crypto.randomUUID(),
          key,
          label,
          type: 'unsupported',
          required,
          ...(visibility ? { visibility } : {}),
          jsonSchemaFragment: {},
          uiSchemaFragment: control,
        };
        fields.push(field);
        continue;
      }

      // Check if this is a repeat field (array with items.type === 'object')
      if (
        prop.type === 'array' &&
        prop.items !== null &&
        typeof prop.items === 'object' &&
        (prop.items as Record<string, unknown>).type === 'object'
      ) {
        const items = prop.items as Record<string, unknown>;
        const childProps = (items.properties ?? {}) as Record<string, unknown>;
        const childRequired = new Set<string>(
          Array.isArray(items.required) ? (items.required as string[]) : [],
        );
        // For repeat children, we process them in property-declaration order
        const childElements: UiElement[] = Object.keys(childProps).map((childKey) => ({
          type: 'Control',
          scope: `#/properties/${childKey}`,
          label: childKey,
        }));
        const childVisitedKeys = new Set<string>();
        const children = walkElements(
          childElements,
          childProps,
          childRequired,
          visibilityRules,
          childVisitedKeys,
        );

        const repeatOpts = baseOptions(uiOptions);
        const repeat: RepeatField = {
          id: crypto.randomUUID(),
          key,
          label,
          type: 'repeat',
          required,
          children,
          ...(visibility ? { visibility } : {}),
          ...(repeatOpts ? { options: repeatOpts } : {}),
        };
        fields.push(repeat);
        continue;
      }

      const field = inferFieldType(key, label, prop, uiOptions, required, visibility);
      fields.push(field);
      continue;
    }

    // Unknown UISchema element type — if it has a scope, treat it as an unsupported field
    // whose uiSchemaFragment is the element itself (this preserves custom/pass-through elements).
    const elRecord = el as Record<string, unknown>;
    if (typeof elRecord.scope === 'string') {
      const key = extractKey(elRecord.scope);
      visitedKeys.add(key);
      const prop = (properties[key] ?? {}) as Record<string, unknown>;
      const required = requiredSet.has(key);
      const visibility = visibilityRules[key] as CompoundVisibility | undefined;
      // Try to get label from the element or fall back to key
      const label = typeof elRecord.label === 'string' ? elRecord.label : key;
      const field: UnsupportedField = {
        id: crypto.randomUUID(),
        key,
        label,
        type: 'unsupported',
        required,
        ...(visibility ? { visibility } : {}),
        jsonSchemaFragment: prop,
        uiSchemaFragment: el,
      };
      fields.push(field);
    }
    // If no scope at all, skip silently
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function fromSchema(schema: SchemaOutput): FieldDefinition[] {
  const jsonSchema = schema.jsonSchema as Record<string, unknown>;
  const uiSchema = schema.uiSchema as Record<string, unknown>;
  const visibilityRules = schema.visibilityRules as Record<string, unknown>;

  const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>;
  const requiredArray = Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [];
  const requiredSet = new Set<string>(requiredArray);

  const elements = (uiSchema.elements ?? []) as UiElement[];

  const visitedKeys = new Set<string>();
  const fields = walkElements(elements, properties, requiredSet, visibilityRules, visitedKeys);

  // Append properties not referenced by any UISchema element as unsupported
  for (const key of Object.keys(properties)) {
    if (!visitedKeys.has(key)) {
      const prop = properties[key] as Record<string, unknown>;
      const required = requiredSet.has(key);
      const visibility = visibilityRules[key] as CompoundVisibility | undefined;
      const field: UnsupportedField = {
        id: crypto.randomUUID(),
        key,
        label: key,
        type: 'unsupported',
        required,
        ...(visibility ? { visibility } : {}),
        jsonSchemaFragment: prop,
      };
      fields.push(field);
    }
  }

  return fields;
}
