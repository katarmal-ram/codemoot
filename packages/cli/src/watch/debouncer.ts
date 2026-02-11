// packages/cli/src/watch/debouncer.ts — Coalescing debouncer for file watch events

export interface ChangeEvent {
  path: string;
  event: 'add' | 'change' | 'unlink';
  ts: number;
}

export interface DebounceConfig {
  quietMs: number; // ms of quiet before flushing (default 800)
  maxWaitMs: number; // max ms before forced flush (default 5000)
  cooldownMs: number; // ms after flush before accepting new batch (default 1500)
  maxBatchSize: number; // max files per batch (default 50)
}

export interface FlushBatch {
  files: string[];
  batchId: string;
  windowStart: number;
  windowEnd: number;
  reason: 'quiet' | 'maxWait' | 'maxBatch' | 'manual';
}

const DEFAULT_CONFIG: DebounceConfig = {
  quietMs: 800,
  maxWaitMs: 5000,
  cooldownMs: 1500,
  maxBatchSize: 50,
};

let batchCounter = 0;

export class Debouncer {
  private config: DebounceConfig;
  private pending: Map<string, ChangeEvent> = new Map();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownUntil = 0;
  private windowStart = 0;
  private onFlush: (batch: FlushBatch) => void;
  private destroyed = false;

  constructor(onFlush: (batch: FlushBatch) => void, config?: Partial<DebounceConfig>) {
    this.onFlush = onFlush;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  push(e: ChangeEvent): boolean {
    if (this.destroyed) return false;
    if (e.ts < this.cooldownUntil) return false;

    if (this.pending.size === 0) {
      this.windowStart = e.ts;
      this.startMaxWaitTimer();
    }

    this.pending.set(e.path, e);
    this.restartQuietTimer();

    if (this.pending.size >= this.config.maxBatchSize) {
      this.flush('maxBatch');
    }

    return true;
  }

  flushNow(): void {
    this.flush('manual');
  }

  cancel(): void {
    this.clearTimers();
    this.pending.clear();
  }

  destroy(): void {
    this.cancel();
    this.destroyed = true;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private flush(reason: FlushBatch['reason']): void {
    if (this.pending.size === 0) return;
    this.clearTimers();

    const now = Date.now();
    const batch: FlushBatch = {
      files: [...this.pending.keys()],
      batchId: `wb-${++batchCounter}`,
      windowStart: this.windowStart,
      windowEnd: now,
      reason,
    };

    this.pending.clear();
    this.cooldownUntil = now + this.config.cooldownMs;
    this.onFlush(batch);
  }

  private restartQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flush('quiet'), this.config.quietMs);
  }

  private startMaxWaitTimer(): void {
    if (this.maxWaitTimer) return;
    this.maxWaitTimer = setTimeout(() => this.flush('maxWait'), this.config.maxWaitMs);
  }

  private clearTimers(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
