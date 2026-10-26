import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTtlFromEnv, type TtlSource } from "@pas/shared";

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface AppConfig {
  port: number;
  host: string;
  /** NODE_ENV=production: inne bezpieczne wartości domyślne (HOST, panel ops). */
  production: boolean;
  databasePath: string;
  ttlMs: number;
  /** Skąd wziął się TTL i czy obie zmienne TTL były ustawione naraz — do logu startowego. */
  ttlSource: TtlSource;
  ttlConflict: boolean;
  opsEnabled: boolean;
  /** Gdy ustawiony, `/api/ops/*` wymaga nagłówka `Authorization: Bearer <token>`. */
  opsToken: string | null;
  /** Zbudowany frontend (apps/web/dist) serwowany przez API; null = nie serwujemy. */
  webDistPath: string | null;
  /** Fastify `trustProxy`: za reverse proxy limity muszą widzieć IP klienta, nie proxy. */
  trustProxy: boolean | number | string;
  mail: {
    providerUrl: string;
    controlUrl: string;
    timeoutMs: number;
    retryAttempts: number;
    retryBaseDelayMs: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
  };
  worker: {
    enabled: boolean;
    intervalMs: number;
    maxAttempts: number;
    leaseMs: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };
  overload: {
    maxInFlight: number;
    retryAfterSeconds: number;
  };
  rateLimit: {
    enabled: boolean;
    global: BucketConfig;
    reservation: BucketConfig;
    purchase: BucketConfig;
  };
  bulkhead: {
    waitTimeoutMs: number;
    read: { concurrency: number; queue: number };
    write: { concurrency: number; queue: number };
  };
}

type Env = Record<string, string | undefined>;

function readInt(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.round(value);
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Liczba zaufanych hopów (zalecane, np. `1` za jednym proxy), lista adresów/podsieci
 * proxy albo `true`. Liczba ma pierwszeństwo: `1` to jeden hop, nie „ufaj wszystkim”.
 * `true` bierze pierwszy adres z X-Forwarded-For, który klient może podrobić.
 */
function readTrustProxy(env: Env): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops === 0 ? false : hops;
  const lowered = raw.toLowerCase();
  if (["true", "yes", "on"].includes(lowered)) return true;
  if (["false", "no", "off"].includes(lowered)) return false;
  return raw;
}

/** Domyślnie apps/web/dist obok apps/api — ta sama ścieżka z src/ (tsx) i z dist/ (bundle). */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

function readWebDistPath(env: Env): string | null {
  if (!readBool(env, "SERVE_WEB", true)) return null;
  const dir = env.WEB_DIST_PATH?.trim() ? resolve(env.WEB_DIST_PATH.trim()) : DEFAULT_WEB_DIST;
  // Bez zbudowanego frontendu API działa samo, jak w trybie dev.
  return existsSync(resolve(dir, "index.html")) ? dir : null;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const ttl = resolveTtlFromEnv(env);
  const production = env.NODE_ENV?.trim() === "production";

  return {
    port: readInt(env, "PORT", 3001, 1),
    // Lokalnie tylko loopback; na serwerze/w kontenerze API musi słuchać na wszystkich interfejsach.
    host: env.HOST?.trim() || (production ? "0.0.0.0" : "127.0.0.1"),
    production,
    databasePath: env.DATABASE_PATH?.trim() || "data/pas.sqlite",
    ttlMs: ttl.ttlMs,
    ttlSource: ttl.source,
    ttlConflict: ttl.conflict,
    // Panel ops pokazuje reservationId i treść maili — na produkcji tylko po jawnym włączeniu.
    opsEnabled: readBool(env, "OPS_ENABLED", !production),
    opsToken: env.OPS_TOKEN?.trim() || null,
    webDistPath: readWebDistPath(env),
    trustProxy: readTrustProxy(env),
    mail: {
      providerUrl: env.MAIL_PROVIDER_URL?.trim() || "http://127.0.0.1:3002/send",
      controlUrl: env.MAIL_CONTROL_URL?.trim() || "http://127.0.0.1:3002",
      timeoutMs: readInt(env, "MAIL_TIMEOUT_MS", 1200, 50),
      retryAttempts: readInt(env, "MAIL_RETRY_ATTEMPTS", 2, 1),
      retryBaseDelayMs: readInt(env, "MAIL_RETRY_BASE_DELAY_MS", 250, 0),
      breakerFailureThreshold: readInt(env, "MAIL_BREAKER_FAILURE_THRESHOLD", 4, 1),
      breakerResetMs: readInt(env, "MAIL_BREAKER_RESET_MS", 15_000, 100),
    },
    worker: {
      enabled: readBool(env, "WORKER_ENABLED", true),
      intervalMs: readInt(env, "WORKER_INTERVAL_MS", 250, 25),
      maxAttempts: readInt(env, "WORKER_MAX_ATTEMPTS", 5, 1),
      leaseMs: readInt(env, "WORKER_LEASE_MS", 30_000, 500),
      baseBackoffMs: readInt(env, "WORKER_BASE_BACKOFF_MS", 2_000, 10),
      maxBackoffMs: readInt(env, "WORKER_MAX_BACKOFF_MS", 60_000, 100),
    },
    overload: {
      maxInFlight: readInt(env, "LOAD_SHED_MAX_IN_FLIGHT", 80, 1),
      retryAfterSeconds: readInt(env, "LOAD_SHED_RETRY_AFTER", 5, 1),
    },
    rateLimit: {
      enabled: readBool(env, "RATE_LIMIT_ENABLED", true),
      // Normalny klient (także tester z jednego IP) mieści się w limicie,
      // a zalew 100 rezerwacji w 10 s dostaje 429 po ok. 60–80 próbach.
      // Do limitu rezerwacji liczą się tylko requesty, które przeszły walidację
      // (400/404 oddają żeton) — patrz createRateLimitGuard w app.ts.
      global: { capacity: 300, refillPerSecond: 10 },
      reservation: {
        capacity: readInt(env, "RATE_LIMIT_RESERVATION_CAPACITY", 60, 1),
        refillPerSecond: readInt(env, "RATE_LIMIT_RESERVATION_REFILL_PER_SECOND", 2, 0),
      },
      purchase: { capacity: 40, refillPerSecond: 2 },
    },
    bulkhead: {
      waitTimeoutMs: readInt(env, "BULKHEAD_WAIT_MS", 1_000, 10),
      read: {
        concurrency: readInt(env, "READ_BULKHEAD_CONCURRENCY", 32, 1),
        queue: readInt(env, "READ_BULKHEAD_QUEUE", 100, 0),
      },
      write: {
        concurrency: readInt(env, "WRITE_BULKHEAD_CONCURRENCY", 8, 1),
        queue: readInt(env, "WRITE_BULKHEAD_QUEUE", 40, 0),
      },
    },
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function mergeConfig(base: AppConfig, override?: DeepPartial<AppConfig>): AppConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    mail: { ...base.mail, ...override.mail },
    worker: { ...base.worker, ...override.worker },
    overload: { ...base.overload, ...override.overload },
    rateLimit: {
      ...base.rateLimit,
      ...override.rateLimit,
      global: { ...base.rateLimit.global, ...override.rateLimit?.global },
      reservation: { ...base.rateLimit.reservation, ...override.rateLimit?.reservation },
      purchase: { ...base.rateLimit.purchase, ...override.rateLimit?.purchase },
    },
    bulkhead: {
      ...base.bulkhead,
      ...override.bulkhead,
      read: { ...base.bulkhead.read, ...override.bulkhead?.read },
      write: { ...base.bulkhead.write, ...override.bulkhead?.write },
    },
  };
}

/** Ostrzeżenia o konfiguracji, która po cichu psuje tryb testowy albo bezpieczeństwo. */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.ttlConflict) {
    warnings.push(
      `Ustawione są RESERVATION_TTL_SECONDS i RESERVATION_TTL_MINUTES — wygrywa SECONDS ` +
        `(${Math.round(config.ttlMs / 1000)} s). Usuń zmienną, której nie chcesz.`,
    );
  }
  if (config.trustProxy === true) {
    warnings.push(
      "TRUST_PROXY=true ufa całemu X-Forwarded-For, więc klient może podrobić IP i obejść limit. " +
        "Ustaw liczbę proxy przed API, np. TRUST_PROXY=1.",
    );
  }
  if (config.opsEnabled && config.production && !config.opsToken) {
    warnings.push(
      "Panel ops jest włączony na produkcji bez OPS_TOKEN — każdy widzi reservationId i kody biletów.",
    );
  }
  return warnings;
}

/** Ładuje .env z katalogu pakietu albo z roota repo, jeśli istnieje. */
export function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
