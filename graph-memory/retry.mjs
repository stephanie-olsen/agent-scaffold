// retry.mjs — SQLITE_BUSY retry with exponential backoff
//
// better-sqlite3's busy_timeout handles most cases at the C level,
// but if the timeout is exceeded (e.g., parallel workers with long operations),
// this retries at the application level.

/**
 * Retry a synchronous function on SQLITE_BUSY errors.
 * @param {Function} fn - Synchronous function to retry
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @param {number} baseDelayMs - Initial delay between retries (default 100ms)
 * @returns {*} Result of fn()
 */
export function retryOnBusy(fn, maxRetries = 3, baseDelayMs = 100) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      const isBusy = err.code === 'SQLITE_BUSY' ||
        (err.message && err.message.includes('SQLITE_BUSY'));
      if (!isBusy || attempt === maxRetries) throw err;
      // Synchronous sleep via Atomics (better-sqlite3 is sync anyway)
      const delay = baseDelayMs * Math.pow(2, attempt);
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, delay);
    }
  }
}
