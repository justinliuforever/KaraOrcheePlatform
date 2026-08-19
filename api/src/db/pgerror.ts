/// The driver's SQLSTATE arrives wrapped by drizzle, and a wrapper can carry a `code` of its own, so
/// walk the cause chain and take the first one shaped like a SQLSTATE.
export function pgErrorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
