import type { CheckoutService, SweepResult } from "./checkout";

export interface PointsSweeperOptions {
  checkout: CheckoutService;
  intervalMs: number;
  batchSize: number;
  clock: () => number;
  /** Błąd całego przebiegu (np. baza) — tylko do logu; pojedyncze sesje mają własny backoff. */
  onError?: (error: unknown) => void;
}

export interface PointsSweeperSnapshot {
  lastRunAt: string | null;
  released: number;
  failed: number;
}

/**
 * Cykliczny zwrot punktów porzuconych sesji (III.B4): co `intervalMs` (domyślnie 2 s)
 * `CheckoutService.releaseAbandonedSessionPoints`. Przy TTL rezerwacji 2 min i limicie
 * „najpóźniej 15 s po expiresAt” zostaje zapas na Stripe i Voucherify.
 * Przebiegi się nie nakładają: wolny Stripe opóźnia następny, a nie mnoży wywołań.
 */
export class PointsReleaseSweeper {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private released = 0;
  private failed = 0;

  constructor(private readonly options: PointsSweeperOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current;
  }

  /** Jeden przebieg — używany też bezpośrednio w testach (sterowany zegar). */
  async runOnce(): Promise<SweepResult> {
    this.lastRunAt = new Date(this.options.clock()).toISOString();
    const result = await this.options.checkout.releaseAbandonedSessionPoints(this.options.batchSize);
    this.released += result.released;
    this.failed += result.failed;
    return result;
  }

  snapshot(): PointsSweeperSnapshot {
    return { lastRunAt: this.lastRunAt, released: this.released, failed: this.failed };
  }

  private async tick(): Promise<void> {
    if (this.current) return;
    this.current = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.current = null;
      });
    await this.current;
  }
}
