import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ttlMsFromEnv } from "@pas/shared";

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  ttlMs: number;
  opsEnabled: boolean;
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

export function loadConfig(env: Env = process.env): AppConfig {
  const ttlMs = ttlMsFromEnv(env);

  return {
    port: readInt(env, "PORT", 3001, 1),
    host: env.HOST?.trim() || "127.0.0.1",
    databasePath: env.DATABASE_PATH?.trim() || "data/pas.sqlite",
    ttlMs,
    opsEnabled: readBool(env, "OPS_ENABLED", true),
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
      global: { capacity: 120, refillPerSecond: 2 },
      reservation: { capacity: 10, refillPerSecond: 0.2 },
      purchase: { capacity: 20, refillPerSecond: 0.25 },
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
