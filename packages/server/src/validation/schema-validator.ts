import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
addFormats(ajv);

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

export function validateAgainstSchema(
  data: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): ValidationResult {
  const validate = ajv.compile(jsonSchema);
  const valid = validate(data);
  if (valid) return { valid: true };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? 'unknown error',
    })),
  };
}

export function validateInputData(
  data: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): ValidationResult {
  // inputData is partial — don't enforce required
  const lenientSchema = { ...jsonSchema };
  delete lenientSchema.required;
  return validateAgainstSchema(data, lenientSchema);
}
