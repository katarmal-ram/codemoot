// packages/core/src/engine/cancellation.ts — Request cancellation support

export class CancellationToken {
  private cancelled = false;
  private callbacks = new Set<() => void>();

  /** Signal cancellation. Idempotent — multiple calls are safe. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of this.callbacks) {
      try {
        cb();
      } catch {
        // Swallow callback errors
      }
    }
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Throw if already cancelled. Call before starting expensive work. */
  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new CancellationError('Operation was cancelled');
    }
  }

  /**
   * Register a callback to run on cancellation.
   * Deduplicated by reference — same function won't run twice.
   * If already cancelled, callback fires immediately.
   */
  onCancel(callback: () => void): void {
    if (this.cancelled) {
      callback();
      return;
    }
    this.callbacks.add(callback);
  }

  /** Remove a previously registered callback. */
  offCancel(callback: () => void): void {
    this.callbacks.delete(callback);
  }

  /**
   * Create a promise that resolves after `ms` but can be interrupted by cancellation.
   * Returns true if sleep completed, false if cancelled.
   */
  sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.cancelled) {
        resolve(false);
        return;
      }

      const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
      const onCancelHandler = () => {
        if (state.timer !== undefined) clearTimeout(state.timer);
        resolve(false);
      };

      state.timer = setTimeout(() => {
        this.callbacks.delete(onCancelHandler);
        resolve(true);
      }, ms);

      this.onCancel(onCancelHandler);
    });
  }
}

export class CancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancellationError';
  }
}
