// packages/core/src/engine/event-bus.ts

import { EventEmitter } from 'eventemitter3';
import type { EngineEvent } from '../types/events.js';

interface EventBusEvents {
  event: (event: EngineEvent) => void;
}

/**
 * Typed event bus for AG-UI compatible engine events.
 * Wraps eventemitter3 with typed EngineEvent emission.
 */
export class EventBus extends EventEmitter<EventBusEvents> {
  /** Emit a typed AG-UI event, auto-injecting timestamp if missing. */
  emitEvent(event: EngineEvent): void {
    const timestamped =
      'timestamp' in event && !event.timestamp
        ? { ...event, timestamp: new Date().toISOString() }
        : event;
    this.emit('event', timestamped);
  }
}
