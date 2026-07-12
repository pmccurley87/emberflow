/**
 * Pure value-based secret redaction. Deep-clones a JSON-safe payload,
 * replacing every occurrence of each secret VALUE (raw and its
 * encodeURIComponent form) inside any string leaf with «secret:KEY».
 */
export function redactSecrets<T>(payload: T, secrets: Record<string, string>): T {
  const replacements: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (value.length < 6) continue;
    const token = `«secret:${key}»`;
    const encoded = encodeURIComponent(value);
    const base64 = Buffer.from(value).toString('base64');
    replacements.push([value, token]);
    if (encoded !== value) replacements.push([encoded, token]);
    if (base64 !== value && base64 !== encoded) replacements.push([base64, token]);
  }
  // Longest value first, so an encoded superstring is replaced before the raw substring it contains.
  replacements.sort((a, b) => b[0].length - a[0].length);

  const redactString = (input: string): string =>
    replacements.reduce((acc, [value, token]) => acc.split(value).join(token), input);

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  return walk(payload) as T;
}
