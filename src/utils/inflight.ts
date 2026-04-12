/**
 * InFlightTracker — tracks background promises so we can await them on shutdown.
 *
 * Usage:
 *   const inflight = new InFlightTracker();
 *   inflight.track(someAsyncOperation().catch(handleError));
 *   // on shutdown:
 *   await inflight.drain(5000);
 */

export class InFlightTracker {
  private promises = new Set<Promise<unknown>>();

  track(promise: Promise<unknown>): void {
    this.promises.add(promise);
    promise.finally(() => this.promises.delete(promise));
  }

  async drain(timeoutMs = 5000): Promise<void> {
    if (this.promises.size === 0) return;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([
      Promise.allSettled([...this.promises]),
      timeout,
    ]);
  }

  get size(): number {
    return this.promises.size;
  }
}
