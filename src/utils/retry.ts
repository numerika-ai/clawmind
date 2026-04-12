/**
 * withRetry — simple retry wrapper for transient errors.
 *
 * Retries only for errors classified as transient (network timeout,
 * connection refused, HTTP 429/502/503/504). All other errors propagate
 * immediately without retry.
 */

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;

  // Node.js network errors
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return true;
  if (msg.includes('abort') || msg.includes('timeout')) return true;

  // HTTP status codes in error message (common in fetch wrappers)
  if (/\b(429|502|503|504)\b/.test(msg)) return true;

  return false;
}

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  retryOn?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? 2000;
  const shouldRetry = opts.retryOn ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries && shouldRetry(err)) {
        opts.onRetry?.(err, attempt + 1);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
