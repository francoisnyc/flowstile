import type { Attachment } from '../entities/attachment.entity.js';

export interface AttachmentReference {
  attachmentId: string;
  fileName: string;
  contentType: string;
  size: number;
  checksum: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

export function toReference(att: Attachment): AttachmentReference {
  return {
    attachmentId: att.id,
    fileName: att.fileName,
    contentType: att.contentType,
    size: Number(att.size),
    checksum: att.checksum,
    uploadedBy: att.uploadedById,
    uploadedAt: att.createdAt.toISOString(),
  };
}

export interface AttachmentFieldConfig {
  multiple?: boolean;
  accept?: string[];
  maxSize?: number;
}

// Returns a map of property key → attachment field config for fields that
// carry the x-flowstile-attachment vendor extension.
export function findAttachmentFields(
  jsonSchema: Record<string, unknown>,
): Map<string, AttachmentFieldConfig> {
  const result = new Map<string, AttachmentFieldConfig>();
  const props = (jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, fieldSchema] of Object.entries(props)) {
    if (fieldSchema['x-flowstile-attachment']) {
      result.set(key, (fieldSchema['x-flowstile-attachment'] as AttachmentFieldConfig) ?? {});
    }
  }
  return result;
}

export function isAttachmentReference(value: unknown): value is AttachmentReference {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.attachmentId === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.contentType === 'string' &&
    typeof v.size === 'number' &&
    typeof v.checksum === 'string' &&
    typeof v.uploadedAt === 'string'
  );
}

export interface ReferenceValidationError {
  path: string;
  message: string;
}

export interface ReferenceValidationResult {
  attachmentIds: string[];
  errors: ReferenceValidationError[];
}

// Validates and collects all attachment references from a payload.
// Checks:
//  - known attachment field
//  - correct reference shape
//  - single vs multiple constraint
//  - contentType in accept list (if declared)
//  - size <= field maxSize and globalMaxBytes
export function validateAndCollectReferences(
  payload: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
  opts: { globalMaxBytes?: number } = {},
): ReferenceValidationResult {
  const fields = findAttachmentFields(jsonSchema);
  const attachmentIds: string[] = [];
  const errors: ReferenceValidationError[] = [];

  for (const [key, cfg] of fields) {
    const value = payload[key];
    if (value === undefined || value === null) continue;

    const refs: unknown[] = Array.isArray(value) ? value : [value];

    if (!cfg.multiple && refs.length > 1) {
      errors.push({ path: `/${key}`, message: 'field does not allow multiple attachments' });
      continue;
    }

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const path = cfg.multiple ? `/${key}/${i}` : `/${key}`;

      if (!isAttachmentReference(ref)) {
        errors.push({ path, message: 'invalid attachment reference shape' });
        continue;
      }

      if (cfg.accept && cfg.accept.length > 0) {
        const ct = ref.contentType;
        const allowed = cfg.accept.some((pattern) => {
          if (pattern.endsWith('/*')) {
            return ct.startsWith(pattern.slice(0, -1));
          }
          return ct === pattern;
        });
        if (!allowed) {
          errors.push({ path, message: `contentType '${ct}' not in accepted list: ${cfg.accept.join(', ')}` });
        }
      }

      if (cfg.maxSize !== undefined && ref.size > cfg.maxSize) {
        errors.push({ path, message: `file size ${ref.size} exceeds field limit ${cfg.maxSize}` });
      }

      if (opts.globalMaxBytes !== undefined && ref.size > opts.globalMaxBytes) {
        errors.push({ path, message: `file size ${ref.size} exceeds global limit ${opts.globalMaxBytes}` });
      }

      attachmentIds.push(ref.attachmentId);
    }
  }

  return { attachmentIds, errors };
}
