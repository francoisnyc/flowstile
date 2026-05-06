import { describe, it, expect } from 'vitest';
import { labelToKey, ensureUnique } from './keyUtils.js';

describe('labelToKey', () => {
  it('converts simple label', () => {
    expect(labelToKey('Customer Name')).toBe('CUSTOMER_NAME');
  });

  it('handles single word', () => {
    expect(labelToKey('amount')).toBe('AMOUNT');
  });

  it('strips special characters', () => {
    expect(labelToKey('Amount ($)')).toBe('AMOUNT');
  });

  it('collapses multiple spaces', () => {
    expect(labelToKey('Loan   Amount')).toBe('LOAN_AMOUNT');
  });

  it('trims leading/trailing whitespace', () => {
    expect(labelToKey('  Notes  ')).toBe('NOTES');
  });

  it('handles empty string', () => {
    expect(labelToKey('')).toBe('FIELD');
  });

  it('handles only special characters', () => {
    expect(labelToKey('$$$')).toBe('FIELD');
  });

  it('handles numbers in label', () => {
    expect(labelToKey('Line Item 2')).toBe('LINE_ITEM_2');
  });
});

describe('ensureUnique', () => {
  it('returns key as-is when no conflict', () => {
    expect(ensureUnique('AMOUNT', new Set(['NAME']))).toBe('AMOUNT');
  });

  it('appends _2 on first collision', () => {
    expect(ensureUnique('AMOUNT', new Set(['AMOUNT']))).toBe('AMOUNT_2');
  });

  it('increments past existing suffixes', () => {
    expect(ensureUnique('AMOUNT', new Set(['AMOUNT', 'AMOUNT_2', 'AMOUNT_3']))).toBe('AMOUNT_4');
  });

  it('works with empty set', () => {
    expect(ensureUnique('FIELD', new Set())).toBe('FIELD');
  });
});
