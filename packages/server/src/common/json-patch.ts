// Minimal RFC 6902 (JSON Patch) implementation over RFC 6901 (JSON Pointer).
// Self-contained to avoid a runtime dependency. Supports the six standard
// operations: add, remove, replace, move, copy, test. Applies to a deep clone
// and never mutates the input document.

export type JsonPatchOperation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

export class JsonPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

// Parses a JSON Pointer into its reference tokens, unescaping ~1 → / and ~0 → ~.
function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new JsonPatchError(`Invalid JSON Pointer: ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// Resolves the value at a pointer, throwing if any segment is missing.
function getValue(doc: unknown, tokens: string[]): unknown {
  let current = doc;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const idx = token === '-' ? current.length : Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        throw new JsonPatchError(`Path not found: index ${token}`);
      }
      current = current[idx];
    } else if (current !== null && typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        throw new JsonPatchError(`Path not found: ${token}`);
      }
      current = obj[token];
    } else {
      throw new JsonPatchError(`Cannot traverse into non-object at ${token}`);
    }
  }
  return current;
}

// Navigates to the parent container of the final token, returning it and the token.
function resolveParent(doc: unknown, tokens: string[]): { parent: unknown; token: string } {
  if (tokens.length === 0) throw new JsonPatchError('Root pointer has no parent');
  const parentTokens = tokens.slice(0, -1);
  const parent = getValue(doc, parentTokens);
  return { parent, token: tokens[tokens.length - 1] };
}

function addAt(doc: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) return value; // replace whole document
  const { parent, token } = resolveParent(doc, tokens);
  if (Array.isArray(parent)) {
    const idx = token === '-' ? parent.length : Number(token);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
      throw new JsonPatchError(`Invalid array index for add: ${token}`);
    }
    parent.splice(idx, 0, value);
  } else if (parent !== null && typeof parent === 'object') {
    (parent as Record<string, unknown>)[token] = value;
  } else {
    throw new JsonPatchError(`Cannot add to non-object at ${token}`);
  }
  return doc;
}

function removeAt(doc: unknown, tokens: string[]): { doc: unknown; removed: unknown } {
  if (tokens.length === 0) throw new JsonPatchError('Cannot remove the root document');
  const { parent, token } = resolveParent(doc, tokens);
  if (Array.isArray(parent)) {
    const idx = Number(token);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
      throw new JsonPatchError(`Invalid array index for remove: ${token}`);
    }
    const [removed] = parent.splice(idx, 1);
    return { doc, removed };
  }
  if (parent !== null && typeof parent === 'object') {
    const obj = parent as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, token)) {
      throw new JsonPatchError(`Path not found for remove: ${token}`);
    }
    const removed = obj[token];
    delete obj[token];
    return { doc, removed };
  }
  throw new JsonPatchError(`Cannot remove from non-object at ${token}`);
}

function replaceAt(doc: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  // replace requires the target to exist
  getValue(doc, tokens);
  removeAt(doc, tokens);
  return addAt(doc, tokens, value);
}

// Applies a JSON Patch document, returning a new document. Atomic from the
// caller's perspective: a failure on any operation throws and the original
// (untouched) input is preserved because we operate on a clone.
export function applyJsonPatch<T>(document: T, patch: JsonPatchOperation[]): T {
  let working: unknown = clone(document);

  for (const op of patch) {
    switch (op.op) {
      case 'add':
        working = addAt(working, parsePointer(op.path), clone(op.value));
        break;
      case 'remove':
        working = removeAt(working, parsePointer(op.path)).doc;
        break;
      case 'replace':
        working = replaceAt(working, parsePointer(op.path), clone(op.value));
        break;
      case 'move': {
        const fromTokens = parsePointer(op.from);
        const { removed } = removeAt(working, fromTokens);
        working = addAt(working, parsePointer(op.path), removed);
        break;
      }
      case 'copy': {
        const value = clone(getValue(working, parsePointer(op.from)));
        working = addAt(working, parsePointer(op.path), value);
        break;
      }
      case 'test': {
        const actual = getValue(working, parsePointer(op.path));
        if (!deepEqual(actual, op.value)) {
          throw new JsonPatchError(`Test operation failed at ${op.path}`);
        }
        break;
      }
      default:
        throw new JsonPatchError(`Unsupported operation: ${JSON.stringify(op)}`);
    }
  }

  return working as T;
}
