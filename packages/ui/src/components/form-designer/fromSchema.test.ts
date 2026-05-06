import { describe, it, expect } from 'vitest';
import { fromSchema } from './fromSchema.js';
import { toSchema } from './toSchema.js';
import type {
  FieldDefinition,
  TextField,
  NumberField,
  BooleanField,
  SelectField,
  TextareaField,
  DateField,
  EmailField,
  SectionField,
  RepeatField,
  UnsupportedField,
  CompoundVisibility,
  SchemaOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip auto-generated IDs so we can compare structural equality. */
function stripIds(fields: FieldDefinition[]): unknown[] {
  return fields.map((f) => {
    const { id: _id, ...rest } = f as Record<string, unknown>;
    if (Array.isArray((rest as any).children)) {
      (rest as any).children = stripIds((rest as any).children as FieldDefinition[]);
    }
    return rest;
  });
}

function makeSchema(overrides: Partial<SchemaOutput> = {}): SchemaOutput {
  return {
    jsonSchema: { type: 'object', properties: {}, 'x-flowstile-builder': true },
    uiSchema: { type: 'VerticalLayout', elements: [] },
    visibilityRules: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Text field
// ---------------------------------------------------------------------------

describe('fromSchema – text field', () => {
  it('parses a basic string property with no special markers', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NAME: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/NAME', label: 'Full Name' }],
      },
    });
    const fields = fromSchema(schema);
    expect(fields).toHaveLength(1);
    const f = fields[0] as TextField;
    expect(f.type).toBe('text');
    expect(f.key).toBe('NAME');
    expect(f.label).toBe('Full Name');
    expect(f.required).toBe(false);
    expect(typeof f.id).toBe('string');
    expect(f.id.length).toBeGreaterThan(0);
  });

  it('restores minLength and maxLength', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NAME: { type: 'string', minLength: 2, maxLength: 50 } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/NAME', label: 'Name' }],
      },
    });
    const f = fromSchema(schema)[0] as TextField;
    expect(f.type).toBe('text');
    expect(f.minLength).toBe(2);
    expect(f.maxLength).toBe(50);
  });

  it('restores pattern', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { CODE: { type: 'string', pattern: '^[A-Z]+$' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/CODE', label: 'Code' }],
      },
    });
    const f = fromSchema(schema)[0] as TextField;
    expect(f.type).toBe('text');
    expect(f.pattern).toBe('^[A-Z]+$');
  });
});

// ---------------------------------------------------------------------------
// Number field
// ---------------------------------------------------------------------------

describe('fromSchema – number field', () => {
  it('parses type:number property', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { AGE: { type: 'number' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/AGE', label: 'Age' }],
      },
    });
    const f = fromSchema(schema)[0] as NumberField;
    expect(f.type).toBe('number');
    expect(f.key).toBe('AGE');
  });

  it('parses type:integer as number', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { COUNT: { type: 'integer' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/COUNT', label: 'Count' }],
      },
    });
    const f = fromSchema(schema)[0] as NumberField;
    expect(f.type).toBe('number');
  });

  it('restores minimum and maximum', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { SCORE: { type: 'number', minimum: 0, maximum: 100 } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/SCORE', label: 'Score' }],
      },
    });
    const f = fromSchema(schema)[0] as NumberField;
    expect(f.minimum).toBe(0);
    expect(f.maximum).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Boolean field
// ---------------------------------------------------------------------------

describe('fromSchema – boolean field', () => {
  it('parses type:boolean property', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { AGREED: { type: 'boolean' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/AGREED', label: 'I agree' }],
      },
    });
    const f = fromSchema(schema)[0] as BooleanField;
    expect(f.type).toBe('boolean');
    expect(f.key).toBe('AGREED');
    expect(f.label).toBe('I agree');
  });
});

// ---------------------------------------------------------------------------
// Select field
// ---------------------------------------------------------------------------

describe('fromSchema – select field', () => {
  it('parses string property with enum as select', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { COLOR: { type: 'string', enum: ['red', 'green', 'blue'] } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/COLOR', label: 'Color' }],
      },
    });
    const f = fromSchema(schema)[0] as SelectField;
    expect(f.type).toBe('select');
    expect(f.enumValues).toEqual(['red', 'green', 'blue']);
  });
});

// ---------------------------------------------------------------------------
// Textarea field
// ---------------------------------------------------------------------------

describe('fromSchema – textarea field', () => {
  it('parses string property with options.multi as textarea', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NOTES: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Control',
            scope: '#/properties/NOTES',
            label: 'Notes',
            options: { multi: true },
          },
        ],
      },
    });
    const f = fromSchema(schema)[0] as TextareaField;
    expect(f.type).toBe('textarea');
    expect(f.key).toBe('NOTES');
  });

  it('restores minLength and maxLength for textarea', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NOTES: { type: 'string', minLength: 10, maxLength: 500 } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Control',
            scope: '#/properties/NOTES',
            label: 'Notes',
            options: { multi: true },
          },
        ],
      },
    });
    const f = fromSchema(schema)[0] as TextareaField;
    expect(f.type).toBe('textarea');
    expect(f.minLength).toBe(10);
    expect(f.maxLength).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Date field
// ---------------------------------------------------------------------------

describe('fromSchema – date field', () => {
  it('parses string with format:date as date type', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { DOB: { type: 'string', format: 'date' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/DOB', label: 'Date of Birth' }],
      },
    });
    const f = fromSchema(schema)[0] as DateField;
    expect(f.type).toBe('date');
    expect(f.key).toBe('DOB');
    expect(f.label).toBe('Date of Birth');
  });
});

// ---------------------------------------------------------------------------
// Email field
// ---------------------------------------------------------------------------

describe('fromSchema – email field', () => {
  it('parses string with format:email as email type', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { EMAIL: { type: 'string', format: 'email' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/EMAIL', label: 'Email' }],
      },
    });
    const f = fromSchema(schema)[0] as EmailField;
    expect(f.type).toBe('email');
    expect(f.key).toBe('EMAIL');
  });

  it('restores pattern on email field', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          EMAIL: { type: 'string', format: 'email', pattern: '^.+@company\\.com$' },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/EMAIL', label: 'Work Email' }],
      },
    });
    const f = fromSchema(schema)[0] as EmailField;
    expect(f.type).toBe('email');
    expect(f.pattern).toBe('^.+@company\\.com$');
  });
});

// ---------------------------------------------------------------------------
// Section (Group element)
// ---------------------------------------------------------------------------

describe('fromSchema – section field', () => {
  it('creates a section from a UISchema Group element with nested Controls', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          FIRST_NAME: { type: 'string' },
          LAST_NAME: { type: 'string' },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Group',
            label: 'Personal Info',
            elements: [
              { type: 'Control', scope: '#/properties/FIRST_NAME', label: 'First Name' },
              { type: 'Control', scope: '#/properties/LAST_NAME', label: 'Last Name' },
            ],
          },
        ],
      },
    });

    const fields = fromSchema(schema);
    expect(fields).toHaveLength(1);
    const section = fields[0] as SectionField;
    expect(section.type).toBe('section');
    expect(section.label).toBe('Personal Info');
    expect(section.children).toHaveLength(2);
    expect(section.children[0].key).toBe('FIRST_NAME');
    expect(section.children[1].key).toBe('LAST_NAME');
  });

  it('section field does not have a required property', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { CHILD: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Group',
            label: 'My Section',
            elements: [{ type: 'Control', scope: '#/properties/CHILD', label: 'Child' }],
          },
        ],
      },
    });
    const section = fromSchema(schema)[0] as SectionField;
    expect(section.type).toBe('section');
    expect('required' in section).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repeat group
// ---------------------------------------------------------------------------

describe('fromSchema – repeat field', () => {
  it('creates a repeat field from array property with items.type===object', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          ITEMS: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                PRODUCT: { type: 'string' },
                QUANTITY: { type: 'number' },
              },
              required: ['QUANTITY'],
            },
          },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          { type: 'Control', scope: '#/properties/ITEMS', label: 'Line Items' },
        ],
      },
    });

    const fields = fromSchema(schema);
    expect(fields).toHaveLength(1);
    const repeat = fields[0] as RepeatField;
    expect(repeat.type).toBe('repeat');
    expect(repeat.key).toBe('ITEMS');
    expect(repeat.label).toBe('Line Items');
    expect(repeat.children).toHaveLength(2);
  });

  it('child required fields inside repeat are marked required', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          ROWS: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                A: { type: 'string' },
                B: { type: 'string' },
              },
              required: ['B'],
            },
          },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/ROWS', label: 'Rows' }],
      },
    });

    const repeat = fromSchema(schema)[0] as RepeatField;
    const childA = repeat.children.find((c) => c.key === 'A')!;
    const childB = repeat.children.find((c) => c.key === 'B')!;
    expect((childA as TextField).required).toBe(false);
    expect((childB as TextField).required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported fields
// ---------------------------------------------------------------------------

describe('fromSchema – unsupported fields', () => {
  it('creates unsupported field for oneOf constructs', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          CUSTOM: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/CUSTOM', label: 'Custom' }],
      },
    });

    const f = fromSchema(schema)[0] as UnsupportedField;
    expect(f.type).toBe('unsupported');
    expect(f.key).toBe('CUSTOM');
    expect(f.jsonSchemaFragment).toEqual({ oneOf: [{ type: 'string' }, { type: 'number' }] });
  });

  it('creates unsupported field for $ref constructs', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          REF_FIELD: { $ref: '#/definitions/MyType' },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/REF_FIELD', label: 'Ref' }],
      },
    });

    const f = fromSchema(schema)[0] as UnsupportedField;
    expect(f.type).toBe('unsupported');
    expect(f.key).toBe('REF_FIELD');
  });

  it('appends properties not in UISchema as unsupported', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          KNOWN: { type: 'string' },
          ORPHAN: { type: 'string' },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/KNOWN', label: 'Known' }],
      },
    });

    const fields = fromSchema(schema);
    // KNOWN is first (in UISchema order), ORPHAN appended
    expect(fields).toHaveLength(2);
    expect(fields[0].key).toBe('KNOWN');
    expect(fields[1].key).toBe('ORPHAN');
    expect(fields[1].type).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// Visibility rules restoration
// ---------------------------------------------------------------------------

describe('fromSchema – visibility rules', () => {
  it('restores visibility from visibilityRules object', () => {
    const vis: CompoundVisibility = {
      operator: 'and',
      conditions: [{ field: 'STATUS', op: 'equals', value: 'active' }],
    };
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { DETAILS: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/DETAILS', label: 'Details' }],
      },
      visibilityRules: { DETAILS: vis },
    });

    const f = fromSchema(schema)[0];
    expect(f.visibility).toEqual(vis);
  });

  it('leaves visibility undefined when no rule exists for the field', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NAME: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/NAME', label: 'Name' }],
      },
      visibilityRules: {},
    });

    const f = fromSchema(schema)[0];
    expect(f.visibility).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Required field detection
// ---------------------------------------------------------------------------

describe('fromSchema – required field detection', () => {
  it('marks fields listed in jsonSchema.required as required:true', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: {
          NAME: { type: 'string' },
          NICK: { type: 'string' },
        },
        required: ['NAME'],
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          { type: 'Control', scope: '#/properties/NAME', label: 'Name' },
          { type: 'Control', scope: '#/properties/NICK', label: 'Nickname' },
        ],
      },
    });

    const fields = fromSchema(schema);
    const name = fields.find((f) => f.key === 'NAME')!;
    const nick = fields.find((f) => f.key === 'NICK')!;
    expect((name as TextField).required).toBe(true);
    expect((nick as TextField).required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// placeholder / helpText restoration
// ---------------------------------------------------------------------------

describe('fromSchema – options restoration', () => {
  it('restores placeholder from UISchema element options', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NAME: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Control',
            scope: '#/properties/NAME',
            label: 'Name',
            options: { placeholder: 'Enter name' },
          },
        ],
      },
    });
    const f = fromSchema(schema)[0];
    expect(f.options?.placeholder).toBe('Enter name');
  });

  it('restores helpText from UISchema element options', () => {
    const schema = makeSchema({
      jsonSchema: {
        type: 'object',
        properties: { NAME: { type: 'string' } },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          {
            type: 'Control',
            scope: '#/properties/NAME',
            label: 'Name',
            options: { helpText: 'Your legal name' },
          },
        ],
      },
    });
    const f = fromSchema(schema)[0];
    expect(f.options?.helpText).toBe('Your legal name');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: fromSchema(toSchema(fields)) preserves field definitions
// ---------------------------------------------------------------------------

describe('fromSchema – round-trip', () => {
  it('round-trips a mixed set of fields through toSchema then fromSchema', () => {
    const original: FieldDefinition[] = [
      {
        id: 'f1',
        key: 'NAME',
        label: 'Full Name',
        type: 'text',
        required: true,
        minLength: 2,
        maxLength: 100,
        options: { placeholder: 'Enter name', helpText: 'Legal name' },
      } as TextField,
      {
        id: 'f2',
        key: 'AGE',
        label: 'Age',
        type: 'number',
        required: false,
        minimum: 0,
        maximum: 120,
      } as NumberField,
      {
        id: 'f3',
        key: 'AGREED',
        label: 'Agree to terms',
        type: 'boolean',
        required: false,
      } as BooleanField,
      {
        id: 'f4',
        key: 'COLOR',
        label: 'Favorite Color',
        type: 'select',
        required: false,
        enumValues: ['red', 'green', 'blue'],
      } as SelectField,
      {
        id: 'f5',
        key: 'NOTES',
        label: 'Notes',
        type: 'textarea',
        required: false,
        minLength: 10,
        maxLength: 500,
      } as TextareaField,
      {
        id: 'f6',
        key: 'DOB',
        label: 'Date of Birth',
        type: 'date',
        required: false,
      } as DateField,
      {
        id: 'f7',
        key: 'EMAIL',
        label: 'Email',
        type: 'email',
        required: false,
        pattern: '^.+@company\\.com$',
      } as EmailField,
    ];

    const schema = toSchema(original);
    const restored = fromSchema(schema);

    // Compare without IDs (IDs are re-generated)
    expect(stripIds(restored)).toEqual(stripIds(original));
  });

  it('round-trips a section field (label and children preserved; section key is not stored in schema)', () => {
    // NOTE: toSchema emits a UISchema Group with a label but no key property. The
    // section's designer key is therefore not preserved across the round-trip — only
    // the label and children survive. The test verifies what IS preserved.
    const original: FieldDefinition[] = [
      {
        id: 's1',
        key: 'PERSONAL',
        label: 'Personal Info',
        type: 'section',
        children: [
          {
            id: 'c1',
            key: 'FIRST',
            label: 'First Name',
            type: 'text',
            required: true,
          } as TextField,
          {
            id: 'c2',
            key: 'LAST',
            label: 'Last Name',
            type: 'text',
            required: false,
          } as TextField,
        ],
      } as SectionField,
    ];

    const schema = toSchema(original);
    const restored = fromSchema(schema);

    // Section key is not stored in the schema; only label and children survive
    expect(restored).toHaveLength(1);
    const section = restored[0] as SectionField;
    expect(section.type).toBe('section');
    expect(section.label).toBe('Personal Info');
    expect(section.children).toHaveLength(2);
    expect(section.children[0].key).toBe('FIRST');
    expect(section.children[0].label).toBe('First Name');
    expect((section.children[0] as TextField).required).toBe(true);
    expect(section.children[1].key).toBe('LAST');
    expect((section.children[1] as TextField).required).toBe(false);
  });

  it('round-trips a repeat field (key, type, required, and child keys/types preserved; child labels use key as fallback)', () => {
    // NOTE: toSchema emits repeat children into JSON Schema items.properties but does not
    // store child labels separately. fromSchema reconstructs children from the schema,
    // using the property key as the label. Child keys, types, and required flags ARE preserved.
    const original: FieldDefinition[] = [
      {
        id: 'r1',
        key: 'ITEMS',
        label: 'Line Items',
        type: 'repeat',
        required: false,
        children: [
          { id: 'c1', key: 'PRODUCT', label: 'Product', type: 'text', required: false } as TextField,
          { id: 'c2', key: 'QUANTITY', label: 'Quantity', type: 'number', required: true } as NumberField,
        ],
      } as RepeatField,
    ];

    const schema = toSchema(original);
    const restored = fromSchema(schema);
    expect(restored).toHaveLength(1);
    const repeat = restored[0] as RepeatField;
    expect(repeat.type).toBe('repeat');
    expect(repeat.key).toBe('ITEMS');
    expect(repeat.label).toBe('Line Items');
    expect(repeat.required).toBe(false);
    expect(repeat.children).toHaveLength(2);
    const product = repeat.children.find((c) => c.key === 'PRODUCT')!;
    const quantity = repeat.children.find((c) => c.key === 'QUANTITY')!;
    expect(product.type).toBe('text');
    expect((product as TextField).required).toBe(false);
    expect(quantity.type).toBe('number');
    expect((quantity as NumberField).required).toBe(true);
  });

  it('round-trips visibility rules', () => {
    const vis: CompoundVisibility = {
      operator: 'or',
      conditions: [{ field: 'X', op: 'exists' }],
    };
    const original: FieldDefinition[] = [
      {
        id: 'f1',
        key: 'CONDITIONAL',
        label: 'Conditional',
        type: 'text',
        required: false,
        visibility: vis,
      } as TextField,
    ];

    const schema = toSchema(original);
    const restored = fromSchema(schema);
    expect(stripIds(restored)).toEqual(stripIds(original));
  });

  it('round-trips an unsupported field (key, type, jsonSchemaFragment, and uiSchemaFragment preserved; label uses key as fallback when not in fragment)', () => {
    // NOTE: The original label ('Custom') is stored neither in JSON Schema properties
    // nor in the uiSchemaFragment ({type, scope}). fromSchema falls back to the key.
    // What IS fully preserved: key, type, required, jsonSchemaFragment, uiSchemaFragment.
    const original: FieldDefinition[] = [
      {
        id: 'u1',
        key: 'CUSTOM',
        label: 'Custom',
        type: 'unsupported',
        required: false,
        jsonSchemaFragment: { type: 'string', 'x-widget': 'custom' },
        uiSchemaFragment: { type: 'CustomControl', scope: '#/properties/CUSTOM' },
      } as UnsupportedField,
    ];

    const schema = toSchema(original);
    const restored = fromSchema(schema);
    expect(restored).toHaveLength(1);
    const f = restored[0] as UnsupportedField;
    expect(f.type).toBe('unsupported');
    expect(f.key).toBe('CUSTOM');
    expect(f.required).toBe(false);
    expect(f.jsonSchemaFragment).toEqual({ type: 'string', 'x-widget': 'custom' });
    expect(f.uiSchemaFragment).toEqual({ type: 'CustomControl', scope: '#/properties/CUSTOM' });
  });
});
