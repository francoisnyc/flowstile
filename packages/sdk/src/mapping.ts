import type { JsonPatchOperation } from './types.js';

/**
 * A declarative variable mapping between a task and the case entity.
 *
 * Array form maps each key to the same name; object form renames
 * (source key → destination key). This is **plumbing only** — there are no
 * expressions or transforms. Derived values are computed in the workflow and
 * written there; the mapping just copies and renames.
 */
export type VariableMapping = string[] | Record<string, string>;

/** Normalize either form to `[sourceKey, destKey]` entries. */
export function normalizeMapping(mapping: VariableMapping): Array<[string, string]> {
  return Array.isArray(mapping)
    ? mapping.map((k) => [k, k] as [string, string])
    : Object.entries(mapping);
}

/**
 * `contextFrom` — project case-entity variables into a task `contextData`
 * subset (input mapping). A null/absent entity or a missing source key is
 * skipped (so the first task of a case, before the entity exists, projects
 * nothing rather than failing).
 */
export function projectContext(
  entity: Record<string, unknown> | null | undefined,
  contextFrom: VariableMapping,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!entity) return out;
  for (const [src, dest] of normalizeMapping(contextFrom)) {
    if (Object.prototype.hasOwnProperty.call(entity, src)) out[dest] = entity[src];
  }
  return out;
}

/**
 * `persist` — build a JSON Patch that promotes an allowlist of submission
 * fields into the case entity (output mapping). Missing submission keys are
 * skipped. Uses disjoint-field `add` ops (idempotent under a row lock), so no
 * `expectedVersion` is needed.
 */
export function buildPersistPatch(
  submission: Record<string, unknown>,
  persist: VariableMapping,
): JsonPatchOperation[] {
  const ops: JsonPatchOperation[] = [];
  for (const [src, dest] of normalizeMapping(persist)) {
    if (Object.prototype.hasOwnProperty.call(submission, src)) {
      ops.push({ op: 'add', path: `/${escapePointer(dest)}`, value: submission[src] });
    }
  }
  return ops;
}

// RFC 6901 JSON Pointer escaping for a destination key used as a path segment.
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
