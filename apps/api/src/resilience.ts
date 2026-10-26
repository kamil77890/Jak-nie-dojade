import type { BreakerSnapshot, PoolSnapshot } from "@pas/shared";

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  readonly retryable = true;
  constructor(message = "Bezpiecznik jest otwarty — nie wołamy zależności.") {
    super(message);
    this.name = "CircuitOpenError";
  }
}

interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  clock: () => number;
}

/**
 * Bezpiecznik pamięta błędy całego procesu, nie jednego requestu.
 * CLOSED → OPEN po serii błędów. OPEN → HALF_OPEN po czasie. HALF_OPEN:
 * jeden request próbny; sukces zamyka obwód, błąd otwiera go ponownie.
 */
export class CircuitBreaker {
  state: BreakerState = "closed";
  failures = 0;
  openedAt: number | null = null;
  lastError: string | null = null;
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  async fire<T>(operation: () => Promise<T>): Promise<T> {
    const now = this.options.clock();

    if (this.state === "open") {
      if (this.openedAt !== null && now - this.openedAt >= this.options.resetTimeoutMs) {
        this.state = "half_open";
        this.probeInFlight = false;
      } else {
        throw new CircuitOpenError();
      }
    }

    if (this.state === "half_open") {
      if (this.probeInFlight) throw new CircuitOpenError("Trwa już request próbny.");
      this.probeInFlight = true;
    }

    try {
      const result = await operation();
      this.state = "closed";
      this.failures = 0;
      this.openedAt = null;
      this.probeInFlight = false;
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.probeInFlight = false;

      if (this.state === "half_open" || this.failures >= this.options.failureThreshold) {
        this.state = "open";
        this.openedAt = this.options.clock();
      }
      throw error;
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
      lastError: this.lastError,
    };
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry tylko dla błędów przejściowych. Limit prób i backoff bez końca. */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const canRetry =
        attempt < attempts && (options.shouldRetry ? options.shouldRetry(error, attempt) : true);
      if (!canRetry) throw error;

      const delay = Math.min(
        options.maxDelayMs ?? 5_000,
        options.baseDelayMs * 2 ** (attempt - 1),
      );
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw new Error("withRetry: nieosiągalny stan");
}

interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock: () => number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Token bucket: krótki skok mieści się w pojemności wiadra, stały zalew
 * ogranicza tempo dolewania. Wiele instancji wymaga wspólnego licznika (Redis).
 */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(private readonly options: TokenBucketOptions) {}

  consume(key: string, cost = 1): RateLimitResult {
    const now = this.options.clock();
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, lastRefill: now };
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(
      this.options.capacity,
      bucket.tokens + elapsedSeconds * this.options.refillPerSecond,
    );
    bucket.lastRefill = now;

    let allowed = false;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      allowed = true;
    }

    this.buckets.set(key, bucket);
    this.calls += 1;
    if (this.calls % 500 === 0) this.prune(now);

    const missing = Math.max(0, cost - bucket.tokens);
    const retryAfterSeconds =
      this.options.refillPerSecond > 0 ? Math.ceil(missing / this.options.refillPerSecond) : 60;

    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  private prune(now: number): void {
    const idleLimit = 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > idleLimit) this.buckets.delete(key);
    }
  }
}

export class BulkheadFullError extends Error {
  readonly retryAfter = 1;
  constructor() {
    super("Bulkhead jest pełny.");
    this.name = "BulkheadFullError";
  }
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Osobna pula dla odczytów i zapisów. Wolny request nie zabiera połączeń
 * krytycznej ścieżce zakupu.
 */
export class Bulkhead {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private rejected = 0;

  constructor(
    private readonly options: {
      concurrency: number;
      maxQueue: number;
      waitTimeoutMs: number;
    },
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.options.concurrency) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }

    if (this.queue.length >= this.options.maxQueue) {
      this.rejected += 1;
      return Promise.reject(new BulkheadFullError());
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          this.rejected += 1;
          reject(new BulkheadFullError());
        }, this.options.waitTimeoutMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  snapshot(): PoolSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      concurrency: this.options.concurrency,
      rejected: this.rejected,
    };
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.makeRelease());
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}
