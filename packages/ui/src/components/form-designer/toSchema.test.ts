import { describe, it, expect } from 'vitest';
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
} from './types.js';

// Helper to create a base field with minimal required fields
function makeText(overrides: Partial<TextField> = {}): TextField {
  return {
    id: 'f1',
    key: 'MY_FIELD',
    label: 'My Field',
    type: 'text',
    required: false,
    ...overrides,
  };
}

describe('toSchema', () => {
  describe('empty fields', () => {
    it('returns an empty schema with x-flowstile-builder marker', () => {
      const result = toSchema([]);
      expect(result.jsonSchema).toMatchObject({
        type: 'object',
        'x-flowstile-builder': true,
        properties: {},
      });
      expect(result.uiSchema).toMatchObject({
        type: 'VerticalLayout',
        elements: [],
      });
      expect(result.visibilityRules).toEqual({});
    });

    it('does not include required array when no required fields', () => {
      const result = toSchema([]);
      expect(result.jsonSchema).not.toHaveProperty('required');
    });
  });

  describe('text field', () => {
    it('converts a basic text field', () => {
      const field = makeText({ key: 'NAME' });
      const result = toSchema([field]);
      expect(result.jsonSchema.properties).toMatchObject({
        NAME: { type: 'string' },
      });
      expect((result.uiSchema as any).elements[0]).toMatchObject({
        type: 'Control',
        scope: '#/properties/NAME',
        label: 'My Field',
      });
    });

    it('includes minLength and maxLength', () => {
      const field = makeText({ key: 'NAME', minLength: 2, maxLength: 50 });
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).NAME).toMatchObject({
        type: 'string',
        minLength: 2,
        maxLength: 50,
      });
    });

    it('includes pattern when provided', () => {
      const field = makeText({ key: 'NAME', pattern: '^[A-Z]+$' });
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).NAME).toMatchObject({
        type: 'string',
        pattern: '^[A-Z]+$',
      });
    });
  });

  describe('number field', () => {
    it('converts a basic number field', () => {
      const field: NumberField = {
        id: 'f2',
        key: 'AGE',
        label: 'Age',
        type: 'number',
        required: false,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).AGE).toMatchObject({
        type: 'number',
      });
    });

    it('includes minimum and maximum', () => {
      const field: NumberField = {
        id: 'f2',
        key: 'AGE',
        label: 'Age',
        type: 'number',
        required: false,
        minimum: 0,
        maximum: 120,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).AGE).toMatchObject({
        type: 'number',
        minimum: 0,
        maximum: 120,
      });
    });
  });

  describe('boolean field', () => {
    it('converts a boolean field', () => {
      const field: BooleanField = {
        id: 'f3',
        key: 'AGREED',
        label: 'I agree',
        type: 'boolean',
        required: false,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).AGREED).toMatchObject({
        type: 'boolean',
      });
      expect((result.uiSchema as any).elements[0]).toMatchObject({
        type: 'Control',
        scope: '#/properties/AGREED',
      });
    });
  });

  describe('select field', () => {
    it('includes enum values', () => {
      const field: SelectField = {
        id: 'f4',
        key: 'COLOR',
        label: 'Color',
        type: 'select',
        required: false,
        enumValues: ['red', 'green', 'blue'],
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).COLOR).toMatchObject({
        type: 'string',
        enum: ['red', 'green', 'blue'],
      });
    });
  });

  describe('textarea field', () => {
    it('adds options.multi to UISchema element', () => {
      const field: TextareaField = {
        id: 'f5',
        key: 'NOTES',
        label: 'Notes',
        type: 'textarea',
        required: false,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).NOTES).toMatchObject({
        type: 'string',
      });
      const el = (result.uiSchema as any).elements[0];
      expect(el).toMatchObject({
        type: 'Control',
        scope: '#/properties/NOTES',
        options: { multi: true },
      });
    });

    it('includes minLength and maxLength for textarea', () => {
      const field: TextareaField = {
        id: 'f5',
        key: 'NOTES',
        label: 'Notes',
        type: 'textarea',
        required: false,
        minLength: 10,
        maxLength: 500,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).NOTES).toMatchObject({
        type: 'string',
        minLength: 10,
        maxLength: 500,
      });
    });
  });

  describe('date field', () => {
    it('uses format: date in JSON Schema', () => {
      const field: DateField = {
        id: 'f6',
        key: 'DOB',
        label: 'Date of Birth',
        type: 'date',
        required: false,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).DOB).toMatchObject({
        type: 'string',
        format: 'date',
      });
    });
  });

  describe('email field', () => {
    it('uses format: email in JSON Schema', () => {
      const field: EmailField = {
        id: 'f7',
        key: 'EMAIL',
        label: 'Email Address',
        type: 'email',
        required: false,
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).EMAIL).toMatchObject({
        type: 'string',
        format: 'email',
      });
    });

    it('includes pattern when provided', () => {
      const field: EmailField = {
        id: 'f7',
        key: 'EMAIL',
        label: 'Email',
        type: 'email',
        required: false,
        pattern: '^.+@company\\.com$',
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).EMAIL).toMatchObject({
        type: 'string',
        format: 'email',
        pattern: '^.+@company\\.com$',
      });
    });
  });

  describe('section field', () => {
    it('hoists children properties to top-level and creates a UISchema Group', () => {
      const section: SectionField = {
        id: 's1',
        key: 'PERSONAL',
        label: 'Personal Info',
        type: 'section',
        children: [
          makeText({ id: 'c1', key: 'FIRST_NAME', label: 'First Name', required: false }),
          makeText({ id: 'c2', key: 'LAST_NAME', label: 'Last Name', required: false }),
        ],
      };
      const result = toSchema([section]);

      // Section itself should NOT produce a property
      expect(result.jsonSchema.properties).not.toHaveProperty('PERSONAL');

      // Children are hoisted to top-level
      expect((result.jsonSchema.properties as any).FIRST_NAME).toMatchObject({ type: 'string' });
      expect((result.jsonSchema.properties as any).LAST_NAME).toMatchObject({ type: 'string' });

      // UISchema should have a Group element
      const el = (result.uiSchema as any).elements[0];
      expect(el).toMatchObject({
        type: 'Group',
        label: 'Personal Info',
      });
      expect(el.elements).toHaveLength(2);
      expect(el.elements[0]).toMatchObject({
        type: 'Control',
        scope: '#/properties/FIRST_NAME',
      });
    });

    it('collects required children into top-level required array', () => {
      const section: SectionField = {
        id: 's1',
        key: 'PERSONAL',
        label: 'Personal Info',
        type: 'section',
        children: [
          makeText({ id: 'c1', key: 'FIRST_NAME', label: 'First Name', required: true }),
          makeText({ id: 'c2', key: 'LAST_NAME', label: 'Last Name', required: false }),
        ],
      };
      const result = toSchema([section]);
      expect(result.jsonSchema.required).toContain('FIRST_NAME');
      expect(result.jsonSchema.required).not.toContain('LAST_NAME');
    });
  });

  describe('repeat group field', () => {
    it('creates an array type with items as object containing child properties', () => {
      const repeat: RepeatField = {
        id: 'r1',
        key: 'ITEMS',
        label: 'Line Items',
        type: 'repeat',
        required: false,
        children: [
          makeText({ id: 'c1', key: 'PRODUCT', label: 'Product', required: false }),
          {
            id: 'c2',
            key: 'QUANTITY',
            label: 'Quantity',
            type: 'number',
            required: true,
          } as NumberField,
        ],
      };
      const result = toSchema([repeat]);

      // Should produce an array property
      const prop = (result.jsonSchema.properties as any).ITEMS;
      expect(prop).toMatchObject({
        type: 'array',
        items: {
          type: 'object',
          properties: {
            PRODUCT: { type: 'string' },
            QUANTITY: { type: 'number' },
          },
        },
      });

      // Required children collected inside items
      expect(prop.items.required).toContain('QUANTITY');
      expect(prop.items.required).not.toContain('PRODUCT');

      // UISchema element for repeat
      const el = (result.uiSchema as any).elements[0];
      expect(el).toMatchObject({
        type: 'Control',
        scope: '#/properties/ITEMS',
      });
    });
  });

  describe('unsupported field', () => {
    it('passes through jsonSchemaFragment verbatim', () => {
      const field: UnsupportedField = {
        id: 'u1',
        key: 'CUSTOM',
        label: 'Custom',
        type: 'unsupported',
        required: false,
        jsonSchemaFragment: { type: 'string', 'x-custom': 'widget' },
        uiSchemaFragment: { type: 'CustomControl', scope: '#/properties/CUSTOM' },
      };
      const result = toSchema([field]);
      expect((result.jsonSchema.properties as any).CUSTOM).toEqual({
        type: 'string',
        'x-custom': 'widget',
      });
    });

    it('passes through uiSchemaFragment verbatim', () => {
      const field: UnsupportedField = {
        id: 'u1',
        key: 'CUSTOM',
        label: 'Custom',
        type: 'unsupported',
        required: false,
        jsonSchemaFragment: { type: 'string' },
        uiSchemaFragment: { type: 'CustomControl', scope: '#/properties/CUSTOM' },
      };
      const result = toSchema([field]);
      expect((result.uiSchema as any).elements[0]).toEqual({
        type: 'CustomControl',
        scope: '#/properties/CUSTOM',
      });
    });

    it('omits UISchema element when uiSchemaFragment is absent', () => {
      const field: UnsupportedField = {
        id: 'u1',
        key: 'CUSTOM',
        label: 'Custom',
        type: 'unsupported',
        required: false,
        jsonSchemaFragment: { type: 'string' },
      };
      const result = toSchema([field]);
      expect((result.uiSchema as any).elements).toHaveLength(0);
    });
  });

  describe('visibility rules', () => {
    it('serializes visibility rules keyed by field key', () => {
      const vis: CompoundVisibility = {
        operator: 'and',
        conditions: [{ field: 'STATUS', op: 'equals', value: 'active' }],
      };
      const field = makeText({ key: 'DETAILS', visibility: vis });
      const result = toSchema([field]);
      expect(result.visibilityRules.DETAILS).toEqual(vis);
    });

    it('does not add a visibility rule for fields without one', () => {
      const field = makeText({ key: 'NAME' });
      const result = toSchema([field]);
      expect(result.visibilityRules).not.toHaveProperty('NAME');
    });

    it('collects visibility from multiple fields', () => {
      const vis1: CompoundVisibility = {
        operator: 'and',
        conditions: [{ field: 'X', op: 'exists' }],
      };
      const vis2: CompoundVisibility = {
        operator: 'or',
        conditions: [{ field: 'Y', op: 'notExists' }],
      };
      const fields: FieldDefinition[] = [
        makeText({ key: 'A', visibility: vis1 }),
        makeText({ key: 'B', visibility: vis2 }),
        makeText({ key: 'C' }),
      ];
      const result = toSchema(fields);
      expect(result.visibilityRules).toEqual({ A: vis1, B: vis2 });
    });
  });

  describe('placeholder and helpText', () => {
    it('adds placeholder to UISchema options', () => {
      const field = makeText({
        key: 'NAME',
        options: { placeholder: 'Enter your name' },
      });
      const result = toSchema([field]);
      const el = (result.uiSchema as any).elements[0];
      expect(el.options).toMatchObject({ placeholder: 'Enter your name' });
    });

    it('adds helpText to UISchema options', () => {
      const field = makeText({
        key: 'NAME',
        options: { helpText: 'Your full legal name' },
      });
      const result = toSchema([field]);
      const el = (result.uiSchema as any).elements[0];
      expect(el.options).toMatchObject({ helpText: 'Your full legal name' });
    });

    it('merges placeholder and helpText with field-specific options (e.g. multi)', () => {
      const field: TextareaField = {
        id: 'f5',
        key: 'NOTES',
        label: 'Notes',
        type: 'textarea',
        required: false,
        options: { placeholder: 'Write here...', helpText: 'Up to 500 chars' },
      };
      const result = toSchema([field]);
      const el = (result.uiSchema as any).elements[0];
      expect(el.options).toMatchObject({
        multi: true,
        placeholder: 'Write here...',
        helpText: 'Up to 500 chars',
      });
    });
  });

  describe('x-flowstile-builder marker', () => {
    it('is present on non-empty schemas too', () => {
      const field = makeText({ key: 'NAME' });
      const result = toSchema([field]);
      expect(result.jsonSchema['x-flowstile-builder']).toBe(true);
    });
  });

  describe('required fields', () => {
    it('collects required fields into jsonSchema.required array', () => {
      const fields: FieldDefinition[] = [
        makeText({ key: 'NAME', required: true }),
        makeText({ key: 'NICK', required: false }),
        { id: 'f3', key: 'AGE', label: 'Age', type: 'number', required: true } as NumberField,
      ];
      const result = toSchema(fields);
      expect(result.jsonSchema.required).toEqual(
        expect.arrayContaining(['NAME', 'AGE'])
      );
      expect(result.jsonSchema.required).not.toContain('NICK');
    });

    it('omits required array when no fields are required', () => {
      const fields: FieldDefinition[] = [
        makeText({ key: 'NAME', required: false }),
      ];
      const result = toSchema(fields);
      expect(result.jsonSchema).not.toHaveProperty('required');
    });
  });

  describe('multiple fields', () => {
    it('produces elements in the same order as input fields', () => {
      const fields: FieldDefinition[] = [
        makeText({ id: 'f1', key: 'FIRST', label: 'First' }),
        makeText({ id: 'f2', key: 'SECOND', label: 'Second' }),
        makeText({ id: 'f3', key: 'THIRD', label: 'Third' }),
      ];
      const result = toSchema(fields);
      const elements = (result.uiSchema as any).elements;
      expect(elements[0].scope).toBe('#/properties/FIRST');
      expect(elements[1].scope).toBe('#/properties/SECOND');
      expect(elements[2].scope).toBe('#/properties/THIRD');
    });
  });
});
