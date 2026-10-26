import type { MailMessageView, OpsSnapshot, OpsStatus } from "@pas/shared";
import type { FastifyInstance } from "fastify";
import type { BookingService } from "../booking";
import type { AppConfig } from "../config";
import { HttpError, ValidationError } from "../errors";
import type { GuardState } from "../guards";
import type { JobQueue } from "../jobs";
import type { MailAdmin } from "../mail";
import type { CircuitBreaker } from "../resilience";
import type { TicketMailWorker } from "../worker";
import type { Guard } from "./events";

interface OpsDependencies {
  config: AppConfig;
  clock: () => number;
  startedAt: number;
  bookings: BookingService;
  queue: JobQueue;
  worker: TicketMailWorker;
  breaker: CircuitBreaker;
  guards: GuardState;
  mailAdmin: MailAdmin;
  readGuards: Guard[];
}

const MAIL_MODES = new Set(["healthy", "slow", "down", "flaky"]);

export function registerOpsRoutes(app: FastifyInstance, dependencies: OpsDependencies): void {
  const buildStatus = async (): Promise<OpsStatus> => {
    const { config } = dependencies;
    const mail = await dependencies.mailAdmin.control();

    return {
      now: new Date(dependencies.clock()).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((dependencies.clock() - dependencies.startedAt) / 1000)),
      config: {
        ttlMinutes: config.ttlMs / 60_000,
        ttlSeconds: Math.round(config.ttlMs / 1000),
        mailTimeoutMs: config.mail.timeoutMs,
        mailRetryAttempts: config.mail.retryAttempts,
        workerMaxAttempts: config.worker.maxAttempts,
        loadShedMaxInFlight: config.overload.maxInFlight,
        readBulkheadConcurrency: config.bulkhead.read.concurrency,
        writeBulkheadConcurrency: config.bulkhead.write.concurrency,
      },
      reservations: dependencies.bookings.stats(),
      queue: dependencies.queue.stats(),
      worker: dependencies.worker.snapshot(),
      breaker: dependencies.breaker.snapshot(),
      guards: dependencies.guards.snapshot(),
      mail: {
        available: mail !== null,
        mode: mail?.mode ?? "unknown",
        sent: mail?.sent ?? 0,
        lastModeChangeAt: mail?.lastModeChangeAt ?? null,
      },
    };
  };

  app.get("/api/ops/status", { preHandler: dependencies.readGuards }, async () => buildStatus());

  // Jedna próbka dla /lab: status, joby i skrzynka w jednym requeście.
  // Najpierw status (w tym queue done), potem skrzynka — dzięki temu ack nie wyprzedza wiadomości.
  app.get("/api/ops/snapshot", { preHandler: dependencies.readGuards }, async (): Promise<OpsSnapshot> => {
    const status = await buildStatus();
    const messages = await dependencies.mailAdmin.messages(25);

    return {
      status,
      jobs: dependencies.queue.list(25),
      mail: {
        available: messages !== null,
        messages: messages ?? [],
      },
    };
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/api/ops/jobs",
    { preHandler: dependencies.readGuards },
    async (request) => {
      // SQLite przyjmuje w LIMIT tylko liczbę całkowitą; "1.5" albo "-3" dawały 500.
      const limit = Math.trunc(Number(request.query.limit ?? 30));
      return dependencies.queue.list(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 30);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/ops/jobs/:id/retry",
    async (request) => {
      const retried = dependencies.queue.retry(request.params.id);
      if (!retried) throw new HttpError(404, "NOT_FOUND", "Nie ma takiego joba w DLQ.");
      return { ok: true };
    },
  );

  app.get("/api/ops/mail/messages", async () => {
    const messages = await dependencies.mailAdmin.messages(25);
    return {
      available: messages !== null,
      messages: messages ?? ([] as MailMessageView[]),
    };
  });

  app.post("/api/ops/mail/control", async (request) => {
    const mode = readMode(request.body);
    const control = await dependencies.mailAdmin.setMode(mode);
    if (!control) {
      throw new HttpError(503, "MAIL_UNAVAILABLE", "Mock dostawcy e-mail nie odpowiada.");
    }
    return control;
  });

  app.post("/api/ops/mail/reset", async () => {
    const reset = await dependencies.mailAdmin.reset();
    if (!reset) {
      throw new HttpError(503, "MAIL_UNAVAILABLE", "Mock dostawcy e-mail nie odpowiada.");
    }
    return { ok: true };
  });
}

function readMode(body: unknown): string {
  if (!body || typeof body !== "object") throw new ValidationError("Brak trybu pracy.");
  const mode = (body as { mode?: unknown }).mode;
  if (typeof mode !== "string" || !MAIL_MODES.has(mode)) {
    throw new ValidationError("Dozwolone tryby: healthy, slow, down, flaky.");
  }
  return mode;
}
