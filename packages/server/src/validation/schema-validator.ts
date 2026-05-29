import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, strict: false });
  addFormats(ajv);
  return ajv;
}

export function validateAgainstSchema(
  data: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): ValidationResult {
  // Fresh instance per call to avoid cache pollution from dynamic schemas
  const ajv = createAjv();
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
