import type {
  CheckoutResponse,
  CreateReservationInput,
  CreateReservationResponse,
  PurchaseResponse,
  ReservationStatusResponse,
} from "@pas/shared";
import type { FastifyInstance } from "fastify";
import type { BookingService } from "../booking";
import { type CheckoutService, isValidIdempotencyKey } from "../checkout";
import { IdempotencyKeyRequiredError, ValidationError } from "../errors";
import type { Guard } from "./events";

interface ReservationRouteDependencies {
  bookings: BookingService;
  checkout: CheckoutService;
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

  // Karta A: sesja Stripe Checkout. Idempotency-Key jest obowiązkowy — podwójne
  // kliknięcie albo ponowienie po zerwanym połączeniu musi dać tę samą sesję.
  app.post<{ Params: { id: string } }>(
    "/api/reservations/:id/checkout",
    { preHandler: dependencies.purchaseGuards },
    async (request): Promise<CheckoutResponse> => {
      const reservationId = readReservationId(request.params.id);
      const header = request.headers["idempotency-key"];
      const key = typeof header === "string" ? header.trim() : "";
      if (!isValidIdempotencyKey(key)) throw new IdempotencyKeyRequiredError();

      return dependencies.checkout.startCheckout(reservationId, key);
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
