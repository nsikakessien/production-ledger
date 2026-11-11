/**
 * BigInt-aware JSON conversion. Money leaves the API as JSON integers (kobo);
 * if a value ever exceeded Number.MAX_SAFE_INTEGER it is emitted as a string
 * rather than silently losing precision.
 */
export function toJsonSafe<T = any>(value: unknown): T {
  return JSON.parse(stringify(value));
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') {
      return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    return v;
  });
}
