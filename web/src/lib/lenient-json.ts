/**
 * JSON that may carry a bare NaN or Infinity as a value: notebook findings written before #678
 * (Python's json.dumps emits them), which JSON.parse refuses. They read as null.
 */
export function parseLenientJson<T>(text: string): T {
  return JSON.parse(text.replace(/([:,[]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g, '$1null')) as T;
}
