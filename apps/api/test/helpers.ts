import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions, type AppServices } from "../src/app";
import { openDatabase } from "../src/db";
import { MailDeliveryError, type Mailer, type SendResult, type TicketMail } from "../src/mail";

export class FakeMailer implements Mailer {
  calls: Array<{ message: TicketMail; key: string }> = [];
  failWith: Error | null = null;

  async send(message: TicketMail, key: string): Promise<SendResult> {
    this.calls.push({ message, key });
    if (this.failWith) throw this.failWith;
    return { id: `mail-${this.calls.length}`, duplicate: false };
  }
}

export interface TestContext {
  app: FastifyInstance;
  services: AppServices;
  mailer: FakeMailer;
  advance: (ms: number) => void;
  now: () => number;
  close: () => Promise<void>;
}

export async function createTestContext(options: {
  overrides?: BuildAppOptions["config"];
  mailer?: FakeMailer;
  mailAdmin?: BuildAppOptions["mailAdmin"];
} = {}): Promise<TestContext> {
  let current = Date.parse("2026-11-01T09:00:00.000Z");
  const clock = () => current;
  const db = openDatabase(":memory:");
  const mailer = options.mailer ?? new FakeMailer();

  const built = await buildApp({
    db,
    clock,
    mailer,
    ...(options.mailAdmin ? { mailAdmin: options.mailAdmin } : {}),
    startWorker: false,
    config: {
      rateLimit: { enabled: false },
      // Testy nie zależą od tego, czy ktoś zbudował apps/web.
      webDistPath: null,
      worker: { enabled: false, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
      mail: { retryBaseDelayMs: 0, breakerFailureThreshold: 100 },
      ...options.overrides,
    },
  });

  return {
    app: built.app,
    services: built.services,
    mailer,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
    close: async () => {
      await built.app.close();
      db.close();
    },
  };
}

export function reservationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "ic-7310-2026-11-21",
    seatId: "5-1",
    customerName: "Anna Kowalska",
    email: "anna@example.com",
    ...overrides,
  };
}

export function transientMailError(): MailDeliveryError {
  return new MailDeliveryError("Dostawca padł", true, 503);
}

export function permanentMailError(): MailDeliveryError {
  return new MailDeliveryError("Zły adres", false, 422);
}
