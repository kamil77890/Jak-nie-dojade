import type {
  CreateReservationInput,
  CreateReservationResponse,
  PurchaseResponse,
} from "@pas/shared";
import type { FastifyInstance } from "fastify";
import type { BookingService } from "../booking";
import { ValidationError } from "../errors";
import type { Guard } from "./events";

interface ReservationRouteDependencies {
  bookings: BookingService;
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
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/reservations/:id/purchase",
    { preHandler: dependencies.purchaseGuards },
    async (request): Promise<PurchaseResponse> => {
      const reservationId = request.params.id?.trim();
      if (!reservationId) throw new ValidationError("Brak identyfikatora rezerwacji.");

      const result = dependencies.bookings.purchase(reservationId);
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
