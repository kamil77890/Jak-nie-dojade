import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { BookingService } from "./booking";
import { EventCatalog } from "./catalog";
import {
  type AppConfig,
  type DeepPartial,
  loadConfig,
  mergeConfig,
} from "./config";
import { type Db, openDatabase } from "./db";
import { BusyError, HttpError, RateLimitedError } from "./errors";
import { GuardState, addLease, releaseLeases } from "./guards";
import { JobQueue } from "./jobs";
import { HttpMailer, MailAdmin, type Mailer } from "./mail";
import { Bulkhead, CircuitBreaker, TokenBucket } from "./resilience";
import { registerEventRoutes, type Guard } from "./routes/events";
import { registerOpsRoutes } from "./routes/ops";
import { registerReservationRoutes } from "./routes/reservations";
import { TicketMailWorker } from "./worker";

export type Clock = () => number;

export interface BuildAppOptions {
  config?: DeepPartial<AppConfig>;
  db?: Db;
  clock?: Clock;
  mailer?: Mailer;
  mailAdmin?: MailAdmin;
  startWorker?: boolean;
  logger?: boolean;
}

export interface AppServices {
  config: AppConfig;
  db: Db;
  ownsDb: boolean;
  catalog: EventCatalog;
  jobs: JobQueue;
  bookings: BookingService;
  breaker: CircuitBreaker;
  worker: TicketMailWorker;
  guards: GuardState;
  mailAdmin: MailAdmin;
  startedAt: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = mergeConfig(loadConfig(), options.config);
  const clock = options.clock ?? (() => Date.now());
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(config.databasePath);

  const catalog = new EventCatalog();
  const jobs = new JobQueue(db, clock);
  const bookings = new BookingService(db, catalog, jobs, config.ttlMs, clock);
  const breaker = new CircuitBreaker({
    failureThreshold: config.mail.breakerFailureThreshold,
    resetTimeoutMs: config.mail.breakerResetMs,
    clock,
  });
  const mailer = options.mailer ?? new HttpMailer(config.mail.providerUrl, config.mail.timeoutMs);
  const mailAdmin =
    options.mailAdmin ?? new MailAdmin(config.mail.controlUrl, Math.min(config.mail.timeoutMs, 500));

  const readPool = new Bulkhead({
    concurrency: config.bulkhead.read.concurrency,
    maxQueue: config.bulkhead.read.queue,
    waitTimeoutMs: config.bulkhead.waitTimeoutMs,
  });
  const writePool = new Bulkhead({
    concurrency: config.bulkhead.write.concurrency,
    maxQueue: config.bulkhead.write.queue,
    waitTimeoutMs: config.bulkhead.waitTimeoutMs,
  });
  const guards = new GuardState(config.overload.maxInFlight, readPool, writePool);

  const worker = new TicketMailWorker({
    queue: jobs,
    bookings,
    catalog,
    mailer,
    breaker,
    config,
    clock,
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });

  const globalLimiter = new TokenBucket({
    capacity: config.rateLimit.global.capacity,
    refillPerSecond: config.rateLimit.global.refillPerSecond,
    clock,
  });
  const reservationLimiter = new TokenBucket({
    capacity: config.rateLimit.reservation.capacity,
    refillPerSecond: config.rateLimit.reservation.refillPerSecond,
    clock,
  });
  const purchaseLimiter = new TokenBucket({
    capacity: config.rateLimit.purchase.capacity,
    refillPerSecond: config.rateLimit.purchase.refillPerSecond,
    clock,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api") || request.url.startsWith("/api/health")) return;
    if (request.method === "OPTIONS") return;

    // Load shedding: szybkie 503, zanim kolejka requestów zje cały serwer.
    if (guards.inFlight >= config.overload.maxInFlight) {
      guards.loadShedRejected += 1;
      reply.header("retry-after", String(config.overload.retryAfterSeconds));
      return reply.code(503).send({
        error: "OVERLOADED",
        retryAfter: config.overload.retryAfterSeconds,
      });
    }

    guards.inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      guards.inFlight = Math.max(0, guards.inFlight - 1);
    };
    addLease(request, release);

    if (config.rateLimit.enabled) {
      const result = globalLimiter.consume(request.ip);
      setRateLimitHeaders(reply, config.rateLimit.global.capacity, result);
      if (!result.allowed) {
        guards.rateLimited += 1;
        throw new RateLimitedError(result.retryAfterSeconds);
      }
    }
  });

  const readGuards: Guard[] = [createBulkheadGuard(readPool)];
  const reservationGuards: Guard[] = [
    createRateLimitGuard(reservationLimiter, config.rateLimit.reservation.capacity, config, guards),
    createBulkheadGuard(writePool),
  ];
  const purchaseGuards: Guard[] = [
    createRateLimitGuard(purchaseLimiter, config.rateLimit.purchase.capacity, config, guards),
    createBulkheadGuard(writePool),
  ];

  registerEventRoutes(app, { catalog, bookings, readGuards });
  registerReservationRoutes(app, { bookings, reservationGuards, purchaseGuards });

  if (config.opsEnabled) {
    registerOpsRoutes(app, {
      config,
      clock,
      startedAt: clock(),
      bookings,
      queue: jobs,
      worker,
      breaker,
      guards,
      mailAdmin,
      readGuards,
    });
  }

  app.get("/api/health", async () => ({
    ok: true,
    now: new Date(clock()).toISOString(),
  }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfter !== undefined) {
        reply.header("retry-after", String(error.retryAfter));
      }
      const payload: { error: string; retryAfter?: number } = { error: error.code };
      if (error.retryAfter !== undefined) payload.retryAfter = error.retryAfter;
      reply.code(error.statusCode).send(payload);
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400 || statusCode === 413) {
      reply.code(statusCode).send({ error: "VALIDATION_ERROR" });
      return;
    }

    request.log.error({ err: error }, "Nieobsłużony błąd API");
    reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND" });
  });

  app.addHook("onResponse", async (request) => {
    releaseLeases(request);
  });

  app.addHook("onRequestAbort", async (request) => {
    releaseLeases(request);
  });

  app.addHook("onClose", async () => {
    await worker.stop();
    if (ownsDb) db.close();
  });

  await app.ready();

  if (options.startWorker && config.worker.enabled) {
    worker.start();
  }

  return {
    app,
    services: {
      config,
      db,
      ownsDb,
      catalog,
      jobs,
      bookings,
      breaker,
      worker,
      guards,
      mailAdmin,
      startedAt: clock(),
    },
  };
}

function createBulkheadGuard(pool: Bulkhead): Guard {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    let release: () => void;
    try {
      release = await pool.acquire();
    } catch {
      throw new BusyError(1);
    }
    addLease(request, release);
  };
}

function createRateLimitGuard(
  limiter: TokenBucket,
  capacity: number,
  config: AppConfig,
  guards: GuardState,
): Guard {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.rateLimit.enabled) return;
    const result = limiter.consume(request.ip);
    setRateLimitHeaders(reply, capacity, result);
    if (!result.allowed) {
      guards.rateLimited += 1;
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  };
}

function setRateLimitHeaders(
  reply: FastifyReply,
  capacity: number,
  result: { remaining: number; retryAfterSeconds: number },
): void {
  reply.header("ratelimit-limit", String(capacity));
  reply.header("ratelimit-remaining", String(result.remaining));
  reply.header("ratelimit-reset", String(result.retryAfterSeconds));
}
