// 基础工具：确定性序列化、哈希、深拷贝、ID、分桶 Map
import crypto from 'node:crypto';

export function deepClone(value) {
  if (value === undefined) return value;
  return structuredClone(value);
}

export function stableStringify(value) {
  // 键排序的规范化 JSON：用于内容哈希与导出校验，不受字段插入顺序影响
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function indexBy(items, key) {
  const map = new Map();
  for (const item of items || []) map.set(item[key], item);
  return map;
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

export class SeatingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SeatingError';
    this.code = code; // 机器可读错误码
    this.details = details;
  }
}

export function assert(condition, code, message, details) {
  if (!condition) throw new SeatingError(code, message, details);
}
