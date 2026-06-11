import { describe, it, expect } from 'vitest';
import {
  toPascalCase,
  toCamelCase,
  schemaToInterface,
  generateProcessFile,
} from '../src/schema-to-ts.js';

describe('toPascalCase', () => {
  it('converts SCREAMING_SNAKE', () => expect(toPascalCase('APPROVE_ORDER')).toBe('ApproveOrder'));
  it('converts kebab-case', () => expect(toPascalCase('confirm-shipment')).toBe('ConfirmShipment'));
  it('converts snake_case', () => expect(toPascalCase('handle_exception')).toBe('HandleException'));
  it('handles single word', () => expect(toPascalCase('DECISION')).toBe('Decision'));
});

describe('toCamelCase', () => {
  it('converts SCREAMING_SNAKE', () => expect(toCamelCase('APPROVE_ORDER')).toBe('approveOrder'));
  it('converts kebab-case', () => expect(toCamelCase('confirm-shipment')).toBe('confirmShipment'));
  it('handles single word', () => expect(toCamelCase('DECISION')).toBe('decision'));
});

describe('schemaToInterface', () => {
  it('emits required vs optional fields correctly', () => {
    const schema = {
      type: 'object',
      properties: {
        DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        NOTES: { type: 'string' },
      },
      required: ['DECISION'],
    };
    const out = schemaToInterface('ApproveOrderOutput', schema);
    expect(out).toContain(`DECISION: 'APPROVED' | 'REJECTED';`);
    expect(out).toContain(`NOTES?: string;`);
    expect(out).toContain('extends Record<string, unknown>');
  });

  it('maps primitive types', () => {
    const schema = {
      type: 'object',
      properties: {
        A: { type: 'string' },
        B: { type: 'number' },
        C: { type: 'integer' },
        D: { type: 'boolean' },
      },
    };
    const out = schemaToInterface('Foo', schema);
    expect(out).toContain('A?: string;');
    expect(out).toContain('B?: number;');
    expect(out).toContain('C?: number;');
    expect(out).toContain('D?: boolean;');
  });

  it('emits Array<T> for array properties', () => {
    const schema = {
      type: 'object',
      properties: {
        ITEMS: { type: 'array', items: { type: 'string' } },
      },
    };
    const out = schemaToInterface('Foo', schema);
    expect(out).toContain('ITEMS?: Array<string>;');
  });

  it('emits inline object for nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        ADDRESS: {
          type: 'object',
          properties: { street: { type: 'string' }, zip: { type: 'string' } },
        },
      },
    };
    const out = schemaToInterface('Foo', schema);
    expect(out).toContain('ADDRESS?:');
    expect(out).toContain('street?:');
    expect(out).toContain('zip?:');
  });

  it('maps x-flowstile-attachment to AttachmentReference', () => {
    const schema = {
      type: 'object',
      properties: {
        DOC: { 'x-flowstile-attachment': {} },
        DOCS: { 'x-flowstile-attachment': { multiple: true } },
      },
    };
    const out = schemaToInterface('Foo', schema);
    expect(out).toContain('DOC?: AttachmentReference;');
    expect(out).toContain('DOCS?: AttachmentReference[];');
  });

  it('returns empty interface for schema with no properties', () => {
    const out = schemaToInterface('Empty', { type: 'object' });
    expect(out).toBe('export interface Empty extends Record<string, unknown> {}');
  });
});

describe('generateProcessFile', () => {
  const forms = new Map([
    [
      'approve-order',
      {
        code: 'approve-order',
        version: 3,
        jsonSchema: {
          type: 'object',
          properties: {
            DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
            REASON: { type: 'string' },
          },
          required: ['DECISION'],
        },
      },
    ],
    [
      'confirm-shipment',
      {
        code: 'confirm-shipment',
        version: 1,
        jsonSchema: {
          type: 'object',
          properties: {
            TRACKING_NUMBER: { type: 'string' },
          },
          required: ['TRACKING_NUMBER'],
        },
      },
    ],
  ]);

  const tasks = [
    { code: 'APPROVE_ORDER', formCode: 'approve-order', milestoneCode: 'APPROVAL', defaultPriority: 'high' },
    { code: 'CONFIRM_SHIPMENT', formCode: 'confirm-shipment', milestoneCode: null, defaultPriority: 'normal' },
  ];
  const plan = ['APPROVAL', 'SHIPMENT'];

  it('produces a parseable TypeScript file with the right structure', () => {
    const out = generateProcessFile({
      processName: 'Order Fulfillment',
      taskQueue: 'flowstile',
      plan,
      tasks,
      forms,
      serverUrl: 'http://localhost:3000',
    });

    expect(out).toContain(`import { defineProcess } from '@flowstile/sdk/process'`);
    expect(out).toContain(`plan: ['APPROVAL', 'SHIPMENT'],`);
    expect(out).toContain('export interface ApproveOrderOutput');
    expect(out).toContain('export interface ConfirmShipmentOutput');
    expect(out).toContain("DECISION: 'APPROVED' | 'REJECTED'");
    expect(out).toContain('REASON?: string');
    expect(out).toContain('TRACKING_NUMBER: string');
    expect(out).toContain('export const orderFulfillmentProcess = defineProcess');
    expect(out).toContain("approveOrder: task<ApproveOrderOutput>('APPROVE_ORDER', { phase: 'APPROVAL', defaults: { priority: 'high' } })");
    expect(out).toContain("confirmShipment: task<ConfirmShipmentOutput>('CONFIRM_SHIPMENT', { phase: null })");
  });

  it('adds the attachment import only when a form has attachment fields', () => {
    const formsWithAttachment = new Map([
      [
        'doc-form',
        {
          code: 'doc-form',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: { FILE: { 'x-flowstile-attachment': {} } },
          },
        },
      ],
    ]);

    const withAttachment = generateProcessFile({
      processName: 'Docs',
      taskQueue: 'q',
      tasks: [{ code: 'UPLOAD', formCode: 'doc-form', defaultPriority: 'normal' }],
      forms: formsWithAttachment,
      serverUrl: 'http://localhost:3000',
    });
    expect(withAttachment).toContain(`import type { AttachmentReference } from '@flowstile/sdk'`);

    const withoutAttachment = generateProcessFile({
      processName: 'Order Fulfillment',
      taskQueue: 'flowstile',
      tasks,
      forms,
      serverUrl: 'http://localhost:3000',
    });
    expect(withoutAttachment).not.toContain('AttachmentReference');
  });

  it('omits priority option when priority is normal', () => {
    const out = generateProcessFile({
      processName: 'Order Fulfillment',
      taskQueue: 'flowstile',
      tasks,
      forms,
      serverUrl: 'http://localhost:3000',
    });
    // CONFIRM_SHIPMENT has defaultPriority: 'normal' — phase only, no defaults
    expect(out).toContain(`confirmShipment: task<ConfirmShipmentOutput>('CONFIRM_SHIPMENT', { phase: null }),`);
    expect(out).not.toMatch(/CONFIRM_SHIPMENT.*priority/);
  });
});
