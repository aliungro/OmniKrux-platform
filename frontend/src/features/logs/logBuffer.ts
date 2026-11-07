import type { LogLine, LogMarker } from "../../api/types";

/** At most this many items are kept per log session; older ones are dropped as new ones arrive. */
export const LOG_CAPACITY = 50_000;

export type LogEntry = LogLine | LogMarker;

/** An entry as kept: `seq` numbers every entry the buffer was given, so it is stable while older ones go. */
export type LogItem = { seq: number } & LogEntry;

export function isMarker(item: LogEntry): item is LogMarker {
  return "marker" in item;
}

/**
 * A ring buffer of log items. Mutable on purpose: a pane at 2,000 lines a second can't copy
 * arrays per message. `version` goes up on every change, so React renders key off it.
 */
export class LogBuffer {
  readonly capacity: number;
  /** Items lost: evicted by the cap, plus those the server dropped for a slow page. */
  dropped = 0;
  /** Items evicted by the cap alone; above zero once the buffer is full. */
  evicted = 0;
  version = 0;
  private ring: LogItem[] = [];
  /** Where the oldest item sits once the ring is full. */
  private start = 0;
  private nextSeq = 0;

  constructor(capacity = LOG_CAPACITY) {
    this.capacity = capacity;
  }

  get length(): number {
    return this.ring.length;
  }

  /** The i-th oldest item kept, or undefined outside 0 ≤ i < length. */
  get(i: number): LogItem | undefined {
    if (i < 0 || i >= this.ring.length) return undefined;
    return this.ring[(this.start + i) % this.capacity];
  }

  push(items: readonly LogEntry[]): void {
    if (items.length === 0) return;
    for (const entry of items) {
      const item: LogItem = { ...entry, seq: this.nextSeq++ };
      if (this.ring.length < this.capacity) {
        this.ring.push(item);
      } else {
        this.ring[this.start] = item;
        this.start = (this.start + 1) % this.capacity;
        this.evicted += 1;
        this.dropped += 1;
      }
    }
    this.version += 1;
  }

  /** Lines the server dropped before they reached the page. */
  addDropped(count: number): void {
    if (count <= 0) return;
    this.dropped += count;
    this.version += 1;
  }

  /** Empty again, for a new stream. Sequence numbers keep counting, so old ones never come back. */
  clear(): void {
    this.ring = [];
    this.start = 0;
    this.dropped = 0;
    this.evicted = 0;
    this.version += 1;
  }
}
