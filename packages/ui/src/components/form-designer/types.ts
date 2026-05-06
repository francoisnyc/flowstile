export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'date'
  | 'email'
  | 'section'
  | 'repeat'
  | 'unsupported';

export interface CompoundVisibility {
  operator: 'and' | 'or';
  conditions: VisibilityCondition[];
}

export interface VisibilityCondition {
  field: string;
  op: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'exists' | 'notExists';
  value?: unknown;
}

interface BaseField {
  id: string;
  key: string;
  label: string;
  required: boolean;
  visibility?: CompoundVisibility;
  options?: { placeholder?: string; helpText?: string };
}

export type TextField = BaseField & {
  type: 'text';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type NumberField = BaseField & {
  type: 'number';
  minimum?: number;
  maximum?: number;
};

export type BooleanField = BaseField & {
  type: 'boolean';
};

export type SelectField = BaseField & {
  type: 'select';
  enumValues: string[];
};

export type TextareaField = BaseField & {
  type: 'textarea';
  minLength?: number;
  maxLength?: number;
};

export type DateField = BaseField & {
  type: 'date';
};

export type EmailField = BaseField & {
  type: 'email';
  pattern?: string;
};

export type SectionField = Omit<BaseField, 'required'> & {
  type: 'section';
  children: FieldDefinition[];
};

export type RepeatField = BaseField & {
  type: 'repeat';
  children: FieldDefinition[];
};

export type UnsupportedField = BaseField & {
  type: 'unsupported';
  jsonSchemaFragment: unknown;
  uiSchemaFragment?: unknown;
};

export type FieldDefinition =
  | TextField
  | NumberField
  | BooleanField
  | SelectField
  | TextareaField
  | DateField
  | EmailField
  | SectionField
  | RepeatField
  | UnsupportedField;

export interface SchemaOutput {
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  visibilityRules: Record<string, unknown>;
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text Input',
  number: 'Number',
  boolean: 'Checkbox',
  select: 'Select',
  textarea: 'Text Area',
  date: 'Date',
  email: 'Email',
  section: 'Section',
  repeat: 'Repeat Group',
  unsupported: 'Unsupported',
};
