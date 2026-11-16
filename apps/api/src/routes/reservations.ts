import type {
  CheckoutResponse,
  CreateReservationInput,
  CreateReservationResponse,
  LoyaltyResponse,
  PurchaseResponse,
  ReservationStatusResponse,
} from "@pas/shared";
import type { FastifyInstance } from "fastify";
import type { BookingService } from "../booking";
import { type CheckoutService, isValidIdempotencyKey } from "../checkout";
import { IdempotencyKeyRequiredError, ValidationError } from "../errors";
import type { LoyaltyService } from "../loyalty";
import type { Guard } from "./events";

interface ReservationRouteDependencies {
  bookings: BookingService;
  checkout: CheckoutService;
  loyalty: LoyaltyService;
  readGuards: Guard[];
  reservationGuards: Guard[];
  purchaseGuards: Guard[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_NAME = 80;
const MAX_EMAIL = 160;

export function registerReservationRoutes(
  app: FastifyInstance,
  dependencies: ReservationRouteDependencies,
): void {
  app.post(
    "/api/reservations",
    { preHandler: dependencies.reservationGuards },
    async (request, reply): Promise<CreateReservationResponse> => {
      const input = parseCreateReservation(request.body);
      const reservation = dependencies.bookings.createReservation(input);

      reply.code(201);
      return {
        reservationId: reservation.id,
        expiresAt: reservation.expiresAt,
        amount: reservation.amount,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/reservations/:id",
    { preHandler: dependencies.readGuards },
    async (request): Promise<ReservationStatusResponse> => {
      return dependencies.bookings.getStatus(readReservationId(request.params.id));
    },
  );

  // Karta A: saldo punktów klienta. E-mail, który jeszcze nic nie kupił, ma 1000 punktów.
  app.get<{ Querystring: { email?: string } }>(
    "/api/loyalty",
    { preHandler: dependencies.readGuards },
    async (request): Promise<LoyaltyResponse> => {
      const email = readEmail(request.query.email);
      return { email, points: await dependencies.loyalty.getBalance(email) };
    },
  );

  // Karta A: sesja Stripe Checkout. Idempotency-Key jest obowiązkowy — podwójne
  // kliknięcie albo ponowienie po zerwanym połączeniu musi dać tę samą sesję.
  // Karta B: opcjonalne `{ points }` zmniejsza kwotę sesji i saldo w Voucherify.
  app.post<{ Params: { id: string } }>(
    "/api/reservations/:id/checkout",
    { preHandler: dependencies.purchaseGuards },
    async (request): Promise<CheckoutResponse> => {
      const reservationId = readReservationId(request.params.id);
      const header = request.headers["idempotency-key"];
      const key = typeof header === "string" ? header.trim() : "";
      if (!isValidIdempotencyKey(key)) throw new IdempotencyKeyRequiredError();

      return dependencies.checkout.startCheckout(reservationId, key, readPoints(request.body));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/reservations/:id/purchase",
    { preHandler: dependencies.purchaseGuards },
    async (request): Promise<PurchaseResponse> => {
      const result = dependencies.bookings.purchase(readReservationId(request.params.id));
      return { code: result.code };
    },
  );
}

function parseCreateReservation(body: unknown): CreateReservationInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError();
  }

  const raw = body as Record<string, unknown>;
  const eventId = readString(raw.eventId);
  const seatId = readString(raw.seatId);
  const customerName = readString(raw.customerName);
  const email = readString(raw.email).toLowerCase();

  if (!eventId || !seatId) {
    throw new ValidationError("Wybierz kurs i miejsce.");
  }
  if (customerName.length < 2 || customerName.length > MAX_NAME) {
    throw new ValidationError("Imię i nazwisko musi mieć od 2 do 80 znaków.");
  }
  if (email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Podaj poprawny adres e-mail.");
  }

  return { eventId, seatId, customerName, email };
}

function readReservationId(raw: string | undefined): string {
  const reservationId = raw?.trim();
  if (!reservationId) throw new ValidationError("Brak identyfikatora rezerwacji.");
  return reservationId;
}

/** Query `email` — ten sam format co przy rezerwacji, bez zmiany wielkości liter w odpowiedzi. */
function readEmail(raw: string | undefined): string {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Podaj poprawny adres e-mail.");
  }
  return email;
}

/** Body checkoutu jest opcjonalne; brak = 0 punktów (tryb z Etapu II). */
function readPoints(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Niepoprawne body checkoutu.");
  }
  const raw = (body as Record<string, unknown>).points;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new ValidationError("Liczba punktów musi być nieujemną liczbą całkowitą.");
  }
  return raw;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
