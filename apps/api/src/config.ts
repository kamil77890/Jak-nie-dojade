import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTtlFromEnv, type TtlSource } from "@pas/shared";
import { isTestSecretKey } from "./payments";

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
  /** Zmienne TTL z niepoprawną wartością (np. "2min"), które zostały zignorowane. */
  ttlInvalid: TtlSource[];
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
  payments: {
    /** sk_test_… / rk_test_… z env. Nigdy nie trafia do przeglądarki ani do logów. */
    stripeSecretKey: string | null;
    /** whsec_… — sekret endpointu webhooka (panel Stripe albo `stripe listen`). */
    stripeWebhookSecret: string | null;
    /** Adres frontendu dla success_url i cancel_url Stripe'a. */
    publicUrl: string;
    timeoutMs: number;
    maxNetworkRetries: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
  };
  /**
   * Program lojalnościowy (Etap III). Voucherify jest źródłem prawdy o saldzie.
   * `memory` to lokalny fallback dla dev/testów, gdy nie ma kluczy Sandboxa.
   */
  loyalty: {
    provider: "voucherify" | "memory";
    appId: string | null;
    appToken: string | null;
    campaignId: string | null;
    apiUrl: string;
    welcomePoints: number;
    timeoutMs: number;
    maxRetries: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
    /**
     * Budżet wywołań Voucherify w oknie godzinowym. Sandbox przyjmuje najwyżej 100/h,
     * domyślnie bierzemy 90 (zapas na ręczne wywołania i drugą instancję).
     */
    hourlyBudget: number;
    /** Rezerwa tylko dla zwrotów i naliczeń punktów (priorytet `critical`). */
    reserveCritical: number;
    /** Rezerwa dla checkoutu: odczyty salda kończą się `reserveCheckout` wcześniej. */
    reserveCheckout: number;
    /** Świeżość cache salda; cache to tylko optymalizacja, prawdą jest Voucherify. */
    balanceCacheTtlMs: number;
    /** Do jakiego wieku stare saldo może zastąpić 503 przy samym wyświetlaniu. */
    balanceStaleTtlMs: number;
    /**
     * Jak długo pamiętamy „ten e-mail nie ma karty w Voucherify” po wyszukaniu w odczycie
     * salda. Krótko (≤ 15 s), żeby karta założona w panelu była widoczna w 15 s.
     */
    noCardCacheTtlMs: number;
    lookupUnknownCards: boolean;
  };
  /**
   * Zwrot punktów porzuconych sesji (III.B4): co `intervalMs` sesje z punktami, których
   * rezerwacja wygasła, są wygaszane w Stripe, a punkty wracają na kartę.
   */
  pointsSweep: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
  };
  /** Wysyłka maili przez Resend (Etap III). Bez klucza zostaje mock HTTP z Etapu I. */
  resend: {
    apiKey: string | null;
    from: string;
    apiUrl: string;
    timeoutMs: number;
  };
  worker: {
    enabled: boolean;
    intervalMs: number;
    maxAttempts: number;
    leaseMs: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    /**
     * Voucherify niedostępny (awaria, limit): job z punktami czeka na zależność z rosnącym
     * odstępem (od `loyaltyRetryBaseMs` do `loyaltyRetryMaxMs`), a próby nie liczą się
     * do `maxAttempts`. Po `loyaltyRetryHorizonMs` od utworzenia joba — zwykłe próby i DLQ.
     */
    loyaltyRetryBaseMs: number;
    loyaltyRetryMaxMs: number;
    loyaltyRetryHorizonMs: number;
  };
  overload: {
    maxInFlight: number;
    retryAfterSeconds: number;
    /** Maksymalny czas na odebranie całego requestu; chroni przed wolnym body. */
    requestTimeoutMs: number;
  };
  rateLimit: {
    enabled: boolean;
    global: BucketConfig;
    reservation: BucketConfig;
    purchase: BucketConfig;
    /** `GET /api/loyalty` per IP — każdy odczyt może kosztować wywołanie Voucherify. */
    loyalty: BucketConfig;
    /**
     * Checkout z punktami, który doszedł do Voucherify (1–4 wywołania z limitu 100/h):
     * osobno per IP i per e-mail rezerwacji.
     */
    pointsCheckoutIp: BucketConfig;
    pointsCheckoutEmail: BucketConfig;
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
    ttlInvalid: ttl.invalid,
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
    payments: {
      stripeSecretKey: env.STRIPE_SECRET_KEY?.trim() || null,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
      publicUrl: env.PUBLIC_URL?.trim() || "http://localhost:5173",
      timeoutMs: readInt(env, "STRIPE_TIMEOUT_MS", 8_000, 500),
      maxNetworkRetries: readInt(env, "STRIPE_MAX_NETWORK_RETRIES", 2, 0),
      breakerFailureThreshold: readInt(env, "STRIPE_BREAKER_FAILURE_THRESHOLD", 5, 1),
      breakerResetMs: readInt(env, "STRIPE_BREAKER_RESET_MS", 30_000, 100),
    },
    loyalty: (() => {
      const appId = env.VOUCHERIFY_APP_ID?.trim() || null;
      const appToken = env.VOUCHERIFY_APP_TOKEN?.trim() || null;
      const campaignId = env.VOUCHERIFY_CAMPAIGN_ID?.trim() || null;
      const requested = env.LOYALTY_PROVIDER?.trim().toLowerCase();
      // Jawne `memory` pozwala odpalić demo bez konta; `auto` wybiera Voucherify tylko z kompletem kluczy.
      let provider: "voucherify" | "memory";
      if (requested === "memory") provider = "memory";
      else if (requested === "voucherify") provider = "voucherify";
      else provider = appId && appToken && campaignId ? "voucherify" : "memory";
      return {
        provider,
        appId,
        appToken,
        campaignId,
        apiUrl: (env.VOUCHERIFY_API_URL?.trim() || "https://api.voucherify.io").replace(/\/+$/, ""),
        welcomePoints: readInt(env, "LOYALTY_WELCOME_POINTS", 1_000, 0),
        timeoutMs: readInt(env, "VOUCHERIFY_TIMEOUT_MS", 5_000, 100),
        maxRetries: readInt(env, "VOUCHERIFY_MAX_RETRIES", 2, 0),
        breakerFailureThreshold: readInt(env, "VOUCHERIFY_BREAKER_FAILURE_THRESHOLD", 5, 1),
        breakerResetMs: readInt(env, "VOUCHERIFY_BREAKER_RESET_MS", 30_000, 100),
        hourlyBudget: readInt(env, "VOUCHERIFY_HOURLY_BUDGET", 90, 1),
        // Podział 90: odczyty do 15, checkout do 70 (co najmniej 55 tylko dla niego),
        // zwroty i naliczenia do 90 (co najmniej 20 tylko dla nich). Odczyty salda nowych
        // e-maili nie wołają Voucherify (lookupUnknownCards), więc mała pula wystarcza;
        // symulacja pełnego testu prowadzącego mieściła się w 58–73 wywołaniach bez odmów
        // dopiero przy rezerwie checkoutu 55. CONTRACT.md §11.6.1.
        reserveCritical: readInt(env, "VOUCHERIFY_RESERVE_CRITICAL", 20, 0),
        reserveCheckout: readInt(env, "VOUCHERIFY_RESERVE_CHECKOUT", 55, 0),
        // 10 s: zmiana salda w panelu Voucherify jest widoczna w sklepie najpóźniej po 10 s.
        balanceCacheTtlMs: readInt(env, "LOYALTY_BALANCE_CACHE_SECONDS", 10, 0) * 1000,
        balanceStaleTtlMs: readInt(env, "LOYALTY_BALANCE_STALE_SECONDS", 600, 0) * 1000,
        noCardCacheTtlMs: readInt(env, "LOYALTY_NO_CARD_CACHE_SECONDS", 10, 0) * 1000,
        // Domyślnie wyłączone: nowy e-mail = 1000 pkt bez wywołania (oszczędza limit 100/h).
        lookupUnknownCards: readBool(env, "LOYALTY_LOOKUP_UNKNOWN_CARDS", false),
      };
    })(),
    pointsSweep: {
      enabled: readBool(env, "POINTS_SWEEP_ENABLED", true),
      intervalMs: readInt(env, "POINTS_SWEEP_INTERVAL_MS", 2_000, 100),
      batchSize: readInt(env, "POINTS_SWEEP_BATCH", 20, 1),
    },
    resend: {
      apiKey: env.RESEND_API_KEY?.trim() || null,
      from: env.RESEND_FROM?.trim() || "PAS Kasa <onboarding@resend.dev>",
      apiUrl: (env.RESEND_API_URL?.trim() || "https://api.resend.com").replace(/\/+$/, ""),
      timeoutMs: readInt(env, "RESEND_TIMEOUT_MS", 5_000, 100),
    },
    worker: {
      enabled: readBool(env, "WORKER_ENABLED", true),
      intervalMs: readInt(env, "WORKER_INTERVAL_MS", 250, 25),
      maxAttempts: readInt(env, "WORKER_MAX_ATTEMPTS", 5, 1),
      leaseMs: readInt(env, "WORKER_LEASE_MS", 30_000, 500),
      baseBackoffMs: readInt(env, "WORKER_BASE_BACKOFF_MS", 2_000, 10),
      maxBackoffMs: readInt(env, "WORKER_MAX_BACKOFF_MS", 60_000, 100),
      loyaltyRetryBaseMs: readInt(env, "WORKER_LOYALTY_RETRY_BASE_MS", 5_000, 100),
      // Najwyżej minuta przerwy: po przywróceniu Voucherify punkty wracają w ≤ 2 min.
      loyaltyRetryMaxMs: readInt(env, "WORKER_LOYALTY_RETRY_MAX_MS", 60_000, 100),
      loyaltyRetryHorizonMs: readInt(env, "WORKER_LOYALTY_RETRY_HORIZON_HOURS", 24, 0) * 3_600_000,
    },
    overload: {
      maxInFlight: readInt(env, "LOAD_SHED_MAX_IN_FLIGHT", 80, 1),
      retryAfterSeconds: readInt(env, "LOAD_SHED_RETRY_AFTER", 5, 1),
      requestTimeoutMs: readInt(env, "REQUEST_TIMEOUT_MS", 10_000, 100),
    },
    rateLimit: {
      enabled: readBool(env, "RATE_LIMIT_ENABLED", true),
      // 40 na start i 4/s: szybki przebieg testera (B3 + B1 + B2 + przygotowanie testów C)
      // mieści się w limicie, zalew 100 rezerwacji w 10 s dostaje ok. 20×429, a po zalewie
      // limit odbudowuje się w ok. 10 s. Requestów wysłanych tuż po zalewie nie uratuje
      // żadne ustawienie, które nadal łapie B5 (porównanie 60/2, 40/4 i 30/5 w README).
      // Odmowy walidacji (400/413/415) oddają żeton, 404 i 409 nie — patrz app.ts.
      global: { capacity: 300, refillPerSecond: 10 },
      reservation: {
        capacity: readInt(env, "RATE_LIMIT_RESERVATION_CAPACITY", 40, 1),
        refillPerSecond: readInt(env, "RATE_LIMIT_RESERVATION_REFILL_PER_SECOND", 4, 0),
      },
      purchase: { capacity: 40, refillPerSecond: 2 },
      // Saldo punktów: 30 odczytów na start i 20 na minutę per IP. Prowadzący testuje
      // z jednego laptopa (UI + curl), a przy 429 pole „Użyj punktów” znika — 10/6
      // blokowało zwykłe sprawdzanie co sekundę. Zalew 200/min (III.A3) dalej dostaje
      // ok. 150×429, a budżet Voucherify chronią pula odczytów i cache.
      loyalty: {
        capacity: readInt(env, "RATE_LIMIT_LOYALTY_CAPACITY", 30, 1),
        refillPerSecond: readInt(env, "RATE_LIMIT_LOYALTY_PER_MINUTE", 20, 0) / 60,
      },
      // Checkout z punktami: per IP 12 na start i 6/h, per e-mail 6 na start i 6/h.
      // Liczą się tylko żądania, które doszły do Voucherify (nie walidacja, 404/409 ani
      // powtórka tej samej sesji); 503 oddaje żeton. 12 mieści test wyścigu z jednego IP
      // (5 e-maili × 2 checkouty) z zapasem; jedno IP zużyje najwyżej ok. 36 wywołań
      // naraz i 18/h dalej — reszta budżetu checkoutu zostaje innym (CONTRACT.md §11.6).
      pointsCheckoutIp: {
        // 30: cały test prowadzącego z jednego IP (punkty także w kryteriach I–II).
        capacity: readInt(env, "RATE_LIMIT_POINTS_IP_CAPACITY", 30, 1),
        refillPerSecond: readInt(env, "RATE_LIMIT_POINTS_IP_PER_HOUR", 6, 0) / 3600,
      },
      pointsCheckoutEmail: {
        capacity: readInt(env, "RATE_LIMIT_POINTS_EMAIL_CAPACITY", 6, 1),
        refillPerSecond: readInt(env, "RATE_LIMIT_POINTS_EMAIL_PER_HOUR", 6, 0) / 3600,
      },
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
  // Tablice podmieniamy w całości, nie element po elemencie.
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function mergeConfig(base: AppConfig, override?: DeepPartial<AppConfig>): AppConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    mail: { ...base.mail, ...override.mail },
    payments: { ...base.payments, ...override.payments },
    loyalty: { ...base.loyalty, ...override.loyalty },
    pointsSweep: { ...base.pointsSweep, ...override.pointsSweep },
    resend: { ...base.resend, ...override.resend },
    worker: { ...base.worker, ...override.worker },
    overload: { ...base.overload, ...override.overload },
    rateLimit: {
      ...base.rateLimit,
      ...override.rateLimit,
      global: { ...base.rateLimit.global, ...override.rateLimit?.global },
      reservation: { ...base.rateLimit.reservation, ...override.rateLimit?.reservation },
      purchase: { ...base.rateLimit.purchase, ...override.rateLimit?.purchase },
      loyalty: { ...base.rateLimit.loyalty, ...override.rateLimit?.loyalty },
      pointsCheckoutIp: { ...base.rateLimit.pointsCheckoutIp, ...override.rateLimit?.pointsCheckoutIp },
      pointsCheckoutEmail: { ...base.rateLimit.pointsCheckoutEmail, ...override.rateLimit?.pointsCheckoutEmail },
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
  for (const name of config.ttlInvalid) {
    warnings.push(
      `${name} ma niepoprawną wartość (to musi być dodatnia liczba, np. 2) — zmienna jest ` +
        `ignorowana, TTL wynosi ${Math.round(config.ttlMs / 1000)} s.`,
    );
  }
  if (config.production && config.ttlSource === "default") {
    warnings.push(
      "Produkcja działa na domyślnym TTL 15 min. Tryb testowy prowadzącego wymaga " +
        "RESERVATION_TTL_MINUTES=2 — bez tego test kończy się na warunku wstępnym.",
    );
  }
  if (config.trustProxy === true) {
    warnings.push(
      "TRUST_PROXY=true ufa całemu X-Forwarded-For, więc klient może podrobić IP i obejść limit. " +
        "Ustaw liczbę proxy przed API, np. TRUST_PROXY=1.",
    );
  }
  const { stripeSecretKey, stripeWebhookSecret } = config.payments;
  if (!stripeSecretKey || !stripeWebhookSecret) {
    warnings.push(
      "Płatności są wyłączone: brak STRIPE_SECRET_KEY albo STRIPE_WEBHOOK_SECRET. " +
        "Checkout i webhook odpowiadają 503 PAYMENTS_UNAVAILABLE.",
    );
  } else if (!isTestSecretKey(stripeSecretKey)) {
    warnings.push(
      "STRIPE_SECRET_KEY nie jest kluczem testowym (sk_test_…) — płatności są wyłączone. " +
        "Etap II działa wyłącznie w trybie testowym Stripe'a.",
    );
  }
  if (config.production && /\/\/(localhost|127\.0\.0\.1)\b/.test(config.payments.publicUrl)) {
    warnings.push(
      `PUBLIC_URL wskazuje ${config.payments.publicUrl} — Stripe odeśle tam klienta po płatności. ` +
        "Ustaw publiczny adres sklepu.",
    );
  }
  if (config.loyalty.provider === "memory") {
    warnings.push(
      "Punkty działają w pamięci procesu (LOYALTY_PROVIDER=memory) — saldo znika po restarcie. " +
        "Do Etapu III ustaw VOUCHERIFY_APP_ID, VOUCHERIFY_APP_TOKEN i VOUCHERIFY_CAMPAIGN_ID.",
    );
  } else if (!config.loyalty.campaignId || !config.loyalty.appId || !config.loyalty.appToken) {
    warnings.push(
      "Voucherify jest wybrany, ale brakuje kompletu kluczy — żądania do Voucherify skończą się 503.",
    );
  }
  const { hourlyBudget, reserveCritical, reserveCheckout } = config.loyalty;
  if (config.loyalty.provider === "voucherify" && reserveCritical + reserveCheckout >= hourlyBudget) {
    warnings.push(
      `VOUCHERIFY_RESERVE_CRITICAL + VOUCHERIFY_RESERVE_CHECKOUT (${reserveCritical + reserveCheckout}) ` +
        `nie mieści się w VOUCHERIFY_HOURLY_BUDGET (${hourlyBudget}) — odczyty salda zawsze dostaną 503.`,
    );
  }
  if (config.loyalty.provider === "voucherify" && hourlyBudget > 100) {
    warnings.push(
      `VOUCHERIFY_HOURLY_BUDGET=${hourlyBudget} przekracza limit Sandboxa (100 wywołań/h) — ` +
        "Voucherify odpowie 429, zanim zadziała nasz budżet.",
    );
  }
  if (!config.resend.apiKey) {
    warnings.push(
      "RESEND_API_KEY nie jest ustawiony — maile idą do lokalnego mocka (MAIL_PROVIDER_URL), " +
        "a nie przez Resend.",
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
