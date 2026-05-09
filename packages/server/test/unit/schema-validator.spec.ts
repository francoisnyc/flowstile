import { describe, it, expect } from 'vitest';
import {
  validateAgainstSchema,
  validateInputData,
} from '../../src/validation/schema-validator.js';

const testSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    amount: { type: 'number' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name', 'amount'],
  additionalProperties: false,
};

describe('validateAgainstSchema', () => {
  it('returns valid for correct data', () => {
    const result = validateAgainstSchema(
      { name: 'Alice', amount: 100 },
      testSchema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('returns errors for wrong types', () => {
    const result = validateAgainstSchema(
      { name: 123, amount: 'not-a-number' },
      testSchema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it('returns error for missing required fields', () => {
    const result = validateAgainstSchema({ name: 'Alice' }, testSchema);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.message?.includes('required'))).toBe(true);
  });

  it('returns error for additional properties', () => {
    const result = validateAgainstSchema(
      { name: 'Alice', amount: 100, extra: 'field' },
      testSchema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.message?.includes('additional'))).toBe(true);
  });

  it('returns valid for empty data against schema with no required', () => {
    const optionalSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const result = validateAgainstSchema({}, optionalSchema);
    expect(result.valid).toBe(true);
  });
});

describe('validateInputData', () => {
  it('does not enforce required fields', () => {
    const result = validateInputData({ amount: 100 }, testSchema);
    expect(result.valid).toBe(true);
  });

  it('still enforces type checks', () => {
    const result = validateInputData({ amount: 'not-a-number' }, testSchema);
    expect(result.valid).toBe(false);
  });

  it('still enforces additionalProperties', () => {
    const result = validateInputData({ extra: 'field' }, testSchema);
    expect(result.valid).toBe(false);
  });
});
