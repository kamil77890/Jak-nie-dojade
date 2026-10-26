import { describe, expect, it } from "vitest";
import {
  Bulkhead,
  BulkheadFullError,
  CircuitBreaker,
  CircuitOpenError,
  TokenBucket,
  withRetry,
} from "../src/resilience";

describe("timeout/retry — E04", () => {
  it("ponawia tylko do limitu prób i zwraca sukces", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("chwilowy błąd");
        return "ok";
      },
      {
        attempts: 3,
        baseDelayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("nie ponawia błędu oznaczonego jako trwały", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("trwały"), { retryable: false });
        },
        {
          attempts: 3,
          baseDelayMs: 0,
          shouldRetry: (error) => (error as { retryable?: boolean }).retryable !== false,
        },
      ),
    ).rejects.toThrow("trwały");
    expect(calls).toBe(1);
  });
});

describe("circuit breaker — E04", () => {
  function createBreaker(clock: () => number) {
    return new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1_000, clock });
  }

  it("zamyka się po sukcesie i otwiera po serii błędów", async () => {
    let now = 0;
    const breaker = createBreaker(() => now);

    await expect(
      breaker.fire(async () => {
        throw new Error("padło");
      }),
    ).rejects.toThrow("padło");
    expect(breaker.state).toBe("closed");

    await expect(breaker.fire(async () => Promise.reject(new Error("padło")))).rejects.toThrow();
    expect(breaker.state).toBe("open");

    await expect(breaker.fire(async () => "nie powinno")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    now = 1_500;
    const result = await breaker.fire(async () => "wróciło");
    expect(result).toBe("wróciło");
    expect(breaker.state).toBe("closed");
    expect(breaker.failures).toBe(0);
  });

  it("po czasie przechodzi w HALF-OPEN i jeden błąd znów otwiera obwód", async () => {
    let now = 0;
    const breaker = createBreaker(() => now);

    for (let index = 0; index < 2; index += 1) {
      await breaker.fire(async () => Promise.reject(new Error("padło"))).catch(() => undefined);
    }
    expect(breaker.state).toBe("open");

    now = 1_100;
    await expect(
      breaker.fire(async () => {
        throw new Error("nadal padło");
      }),
    ).rejects.toThrow();
    expect(breaker.state).toBe("open");
    expect(breaker.openedAt).toBe(1_100);
  });
});

describe("rate limiting — E05", () => {
  it("token bucket dopuszcza skok do pojemności, potem dolewa żetony", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock: () => now });

    expect(bucket.consume("ip").allowed).toBe(true);
    expect(bucket.consume("ip").allowed).toBe(true);
    expect(bucket.consume("ip").allowed).toBe(true);
    const blocked = bucket.consume("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);

    now = 1_000;
    expect(bucket.consume("ip").allowed).toBe(true);
    now = 2_000;
    expect(bucket.consume("ip").allowed).toBe(true);
  });

  it("kluczuje osobno każdego klienta", () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0, clock: () => 0 });
    expect(bucket.consume("a").allowed).toBe(true);
    expect(bucket.consume("a").allowed).toBe(false);
    expect(bucket.consume("b").allowed).toBe(true);
  });
});

describe("bulkhead — E05", () => {
  it("trzyma limit współbieżności i kolejkuje resztę", async () => {
    const pool = new Bulkhead({ concurrency: 1, maxQueue: 1, waitTimeoutMs: 50 });

    const first = await pool.acquire();
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0 });

    const secondPromise = pool.acquire();
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 1 });

    await expect(pool.acquire()).rejects.toBeInstanceOf(BulkheadFullError);

    first();
    const second = await secondPromise;
    expect(pool.snapshot().active).toBe(1);

    second();
    expect(pool.snapshot().active).toBe(0);
  });

  it("odrzuca oczekujące żądanie po timeoucie", async () => {
    const pool = new Bulkhead({ concurrency: 1, maxQueue: 1, waitTimeoutMs: 20 });
    const release = await pool.acquire();

    await expect(pool.acquire()).rejects.toBeInstanceOf(BulkheadFullError);
    release();
    expect(pool.snapshot().active).toBe(0);
  });
});
