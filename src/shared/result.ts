/**
 * A tiny result type used at every trust boundary in this extension:
 * persisted storage, UI/background messages, provider responses and manifest data.
 *
 * Nothing that crosses a boundary is trusted, and nothing is validated by casting.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(...errors: string[]): Result<T> {
  return { ok: false, errors: errors.length > 0 ? errors : ["unknown error"] };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // Auth schemes carry the actual credential, so they are redacted before the keyword
  // patterns below can consume only the scheme name.
  /\b(?:basic|bearer|digest|negotiate)\s+[A-Za-z0-9+/=_.-]{4,}/gi,
  /\b(?:proxy-)?authorization\b\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:password|passwd|secret|token|username)\b\s*[:=]\s*[^\s,;]+/gi,
];

/**
 * Produces a short, user-facing error string that can never contain credentials.
 * Used for UI messages and logs; never log raw error objects from proxy code.
 */
export function describeError(error: unknown, fallback = "Unexpected error"): string {
  let message = fallback;
  if (typeof error === "string" && error.trim() !== "") {
    message = error;
  } else if (error instanceof Error && typeof error.message === "string" && error.message !== "") {
    message = error.message;
  }
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, "[redacted]");
  }
  message = message.replace(/\s+/g, " ").trim();
  if (message.length > 200) {
    message = `${message.slice(0, 197)}...`;
  }
  return message === "" ? fallback : message;
}
