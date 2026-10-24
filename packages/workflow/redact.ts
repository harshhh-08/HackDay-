// Keep the same patterns in services/common.py; shared adversarial fixtures test both.
const patterns: [string, RegExp][] = [
  ['private_key', /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g],
  ['token', /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g],
  ['authorization', /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi],
  ['credential', /\b(?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi],
  ['url_credentials', /:\/\/[^\s/:@]+:[^\s/@]+@/g],
];
export function redact<T>(input: T): { value: T; redactions: { field: string; kind: string; count: number }[] } {
  const redactions: { field: string; kind: string; count: number }[] = [];
  function walk(value: unknown, field: string): unknown {
    if (typeof value === 'string') {
      for (const [kind, pattern] of patterns) {
        let count = 0;
        value = (value as string).replace(pattern, () => { count++; return kind === 'url_credentials' ? '://[REDACTED]@' : '[REDACTED]'; });
        if (count) redactions.push({ field, kind, count });
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${field}.${index}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, field ? `${field}.${key}` : key)]));
    return value;
  }
  return { value: walk(input, '') as T, redactions };
}
