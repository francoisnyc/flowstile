export function labelToKey(label: string): string {
  return label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'FIELD';
}

export function ensureUnique(key: string, existingKeys: Set<string>): string {
  if (!existingKeys.has(key)) return key;
  let n = 2;
  while (existingKeys.has(`${key}_${n}`)) n++;
  return `${key}_${n}`;
}
