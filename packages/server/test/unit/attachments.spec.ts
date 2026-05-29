import { describe, it, expect } from 'vitest';
import {
  findAttachmentFields,
  isAttachmentReference,
  validateAndCollectReferences,
} from '../../src/common/attachments.js';

const makeSchema = (fields: Record<string, unknown>) => ({
  type: 'object',
  properties: fields,
});

describe('findAttachmentFields', () => {
  it('returns empty map for schema with no attachment fields', () => {
    const schema = makeSchema({ name: { type: 'string' } });
    expect(findAttachmentFields(schema).size).toBe(0);
  });

  it('returns entry for each attachment field', () => {
    const schema = makeSchema({
      doc: { type: 'string', 'x-flowstile-attachment': { multiple: false, accept: ['application/pdf'] } },
      name: { type: 'string' },
    });
    const fields = findAttachmentFields(schema);
    expect(fields.size).toBe(1);
    expect(fields.get('doc')).toEqual({ multiple: false, accept: ['application/pdf'] });
  });
});

describe('isAttachmentReference', () => {
  const valid = {
    attachmentId: 'abc',
    fileName: 'file.pdf',
    contentType: 'application/pdf',
    size: 1024,
    checksum: 'deadbeef',
    uploadedBy: null,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a valid reference', () => {
    expect(isAttachmentReference(valid)).toBe(true);
  });

  it('rejects null', () => {
    expect(isAttachmentReference(null)).toBe(false);
  });

  it('rejects missing attachmentId', () => {
    const { attachmentId: _, ...rest } = valid;
    expect(isAttachmentReference(rest)).toBe(false);
  });

  it('rejects size as string', () => {
    expect(isAttachmentReference({ ...valid, size: '1024' })).toBe(false);
  });
});

describe('validateAndCollectReferences', () => {
  const schema = makeSchema({
    invoice: {
      type: 'string',
      'x-flowstile-attachment': { accept: ['application/pdf'], maxSize: 5000 },
    },
    photos: {
      type: 'array',
      'x-flowstile-attachment': { multiple: true },
    },
    name: { type: 'string' },
  });

  const ref = (overrides: Partial<{
    attachmentId: string; contentType: string; size: number
  }> = {}) => ({
    attachmentId: 'id-1',
    fileName: 'file.pdf',
    contentType: 'application/pdf',
    size: 1000,
    checksum: 'abc',
    uploadedBy: null,
    uploadedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('collects attachment ids from valid single and multiple fields', () => {
    const result = validateAndCollectReferences(
      { invoice: ref({ attachmentId: 'id-1' }), photos: [ref({ attachmentId: 'id-2' })] },
      schema,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.attachmentIds).toEqual(['id-1', 'id-2']);
  });

  it('errors on multiple refs in a single field', () => {
    const result = validateAndCollectReferences(
      { invoice: [ref(), ref()] },
      schema,
    );
    expect(result.errors.some((e) => e.path === '/invoice')).toBe(true);
  });

  it('errors on invalid reference shape', () => {
    const result = validateAndCollectReferences({ invoice: { notARef: true } }, schema);
    expect(result.errors.some((e) => e.path === '/invoice')).toBe(true);
  });

  it('errors on contentType not in accept list', () => {
    const result = validateAndCollectReferences(
      { invoice: ref({ contentType: 'image/png' }) },
      schema,
    );
    expect(result.errors.some((e) => e.message.includes('image/png'))).toBe(true);
  });

  it('errors when size exceeds field maxSize', () => {
    const result = validateAndCollectReferences(
      { invoice: ref({ size: 9999 }) },
      schema,
    );
    expect(result.errors.some((e) => e.message.includes('9999'))).toBe(true);
  });

  it('errors when size exceeds global ceiling', () => {
    const result = validateAndCollectReferences(
      { invoice: ref({ size: 3000 }) },
      schema,
      { globalMaxBytes: 2000 },
    );
    expect(result.errors.some((e) => e.message.includes('global limit'))).toBe(true);
  });

  it('ignores non-attachment fields', () => {
    const result = validateAndCollectReferences({ name: 'Alice', invoice: ref() }, schema);
    expect(result.errors).toHaveLength(0);
    expect(result.attachmentIds).toEqual(['id-1']);
  });
});
