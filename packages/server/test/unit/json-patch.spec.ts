import { describe, it, expect } from 'vitest';
import { applyJsonPatch, JsonPatchError } from '../../src/common/json-patch.js';

describe('applyJsonPatch', () => {
  it('adds a new object member', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }])).toEqual({ a: 1, b: 2 });
  });

  it('replaces an existing member', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 9 }])).toEqual({ a: 9 });
  });

  it('removes a member', () => {
    expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }])).toEqual({ a: 1 });
  });

  it('inserts into and appends to arrays', () => {
    expect(applyJsonPatch({ xs: [1, 3] }, [{ op: 'add', path: '/xs/1', value: 2 }])).toEqual({ xs: [1, 2, 3] });
    expect(applyJsonPatch({ xs: [1] }, [{ op: 'add', path: '/xs/-', value: 2 }])).toEqual({ xs: [1, 2] });
  });

  it('handles nested paths', () => {
    expect(
      applyJsonPatch({ a: { b: { c: 1 } } }, [{ op: 'replace', path: '/a/b/c', value: 2 }]),
    ).toEqual({ a: { b: { c: 2 } } });
  });

  it('supports move and copy', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'move', from: '/a', path: '/b' }])).toEqual({ b: 1 });
    expect(applyJsonPatch({ a: 1 }, [{ op: 'copy', from: '/a', path: '/b' }])).toEqual({ a: 1, b: 1 });
  });

  it('passes a satisfied test and fails an unsatisfied one', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 1 }])).toEqual({ a: 1 });
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow(JsonPatchError);
  });

  it('unescapes ~1 and ~0 in pointers', () => {
    expect(applyJsonPatch({ 'a/b': 1 }, [{ op: 'replace', path: '/a~1b', value: 2 }])).toEqual({ 'a/b': 2 });
  });

  it('throws on replace of a missing path', () => {
    expect(() => applyJsonPatch({}, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow(JsonPatchError);
  });

  it('does not mutate the input document', () => {
    const input = { a: 1 };
    applyJsonPatch(input, [{ op: 'add', path: '/b', value: 2 }]);
    expect(input).toEqual({ a: 1 });
  });

  it('applies multiple operations in order', () => {
    const result = applyJsonPatch({ a: 1 }, [
      { op: 'add', path: '/b', value: 2 },
      { op: 'replace', path: '/a', value: 10 },
      { op: 'remove', path: '/b' },
    ]);
    expect(result).toEqual({ a: 10 });
  });

  describe('prototype-pollution guard', () => {
    for (const token of ['__proto__', 'constructor', 'prototype']) {
      it(`rejects a leaf ${token} token`, () => {
        expect(() => applyJsonPatch({}, [{ op: 'add', path: `/${token}`, value: { polluted: true } }]))
          .toThrow(JsonPatchError);
      });
      it(`rejects a nested ${token} token`, () => {
        expect(() => applyJsonPatch({}, [{ op: 'add', path: `/${token}/x`, value: true }]))
          .toThrow(JsonPatchError);
      });
    }

    it('does not pollute Object.prototype', () => {
      expect(() => applyJsonPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: 'yes' }]))
        .toThrow(JsonPatchError);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });
});
