// Shared small utilities — zero external dependencies.
import crypto from 'node:crypto';

/** SHA-256 hex digest of a string. */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic JSON serialization: object keys sorted recursively so that
 * semantically identical data always produces the same byte stream.
 * Used for content fingerprints and on-disk corruption checks.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`)
    .join(',')}}`;
}

/** Content fingerprint of any JSON-serializable value. */
export function fingerprint(value) {
  return sha256(canonicalJSON(value));
}

export function deepClone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const prefixes = new Map();
/** Monotonic id generator scoped to the in-memory process (persistence stores ids verbatim). */
export function makeId(prefix) {
  const n = (prefixes.get(prefix) || 0) + 1;
  prefixes.set(prefix, n);
  return `${prefix}_${String(n).padStart(4, '0')}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Parse "ISO date" style body values into a yyyy-mm-dd string, tolerant of Date input. */
export function dayString(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}
