type PropType = 'string' | 'number' | 'boolean' | 'object' | 'array';
interface ObjectSchema {
  type?: 'object';
  required?: string[];
  properties?: Record<string, { type?: PropType }>;
}

const typeOfValue = (v: unknown): PropType | 'null' | 'undefined' => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v as PropType;
};

/** Minimal subset validator: object type, required keys, per-property primitive
 *  type. Returns null when valid, else the first error message. Unknown schema
 *  shapes impose no constraint (valid) — extend as real schemas demand. */
export function validateAgainstSchema(schema: unknown, value: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as ObjectSchema;
  if (s.type === 'object') {
    if (typeOfValue(value) !== 'object') return 'expected an object';
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) return `missing required field: ${key}`;
    }
    for (const [key, spec] of Object.entries(s.properties ?? {})) {
      if (obj[key] === undefined) continue;
      if (spec.type && typeOfValue(obj[key]) !== spec.type) {
        return `field ${key} must be a ${spec.type}`;
      }
    }
  }
  return null;
}
