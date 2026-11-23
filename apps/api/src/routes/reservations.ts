import type {
  CheckoutResponse,
  CreateReservationInput,
  CreateReservationResponse,
  LoyaltyResponse,
  PurchaseResponse,
  ReservationStatusResponse,
} from "@pas/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BookingService } from "../booking";
import { type CheckoutService, isValidIdempotencyKey } from "../checkout";
import { HttpError, IdempotencyKeyRequiredError, ValidationError } from "../errors";
import type { LoyaltyService } from "../loyalty";
import type { Guard } from "./events";

interface ReservationRouteDependencies {
  bookings: BookingService;
  checkout: CheckoutService;
  loyalty: LoyaltyService;
  readGuards: Guard[];
  /** Limit per IP + pula odczytów: odczyt salda kosztuje wywołanie Voucherify. */
  loyaltyGuards: Guard[];
  reservationGuards: Guard[];
  purchaseGuards: Guard[];
  /** Limit checkoutów z punktami per IP i per e-mail (budżet Voucherify). */
  pointsCharge?: PointsChargeFactory;
}

/**
 * Limit checkoutu z punktami dla jednego żądania: `charge` pobiera żetony (albo rzuca
 * 429 RATE_LIMITED), `refund` je oddaje, gdy żądanie skończyło się 503 — klient nie
 * dostał usługi, więc ponowienie po awarii nie może go zablokować.
 */
export type PointsChargeFactory = (request: FastifyRequest) => {
  charge: (email: string) => void;
  refund: () => void;
};

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
      const { reservation, created } = dependencies.bookings.createReservation(input);

      // 201 — nowa rezerwacja; 200 — powtórka identycznego requestu dostała tę samą
      // (RFC 9110: 201 tylko wtedy, gdy zasób właśnie powstał). Ciało jest takie samo.
      reply.code(created ? 201 : 200);
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
  // E-mail bez mapowania kosztuje jedno wyszukanie karty w Voucherify (karta z panelu/kasy
  // pokazuje prawdziwe saldo); kartę zakładamy dopiero przy pierwszym zapisie punktów.
  // 400 zły e-mail, 429 limit per IP, 503 LOYALTY_UNAVAILABLE z Retry-After.
  app.get<{ Querystring: { email?: unknown } }>(
    "/api/loyalty",
    { preHandler: dependencies.loyaltyGuards },
    async (request): Promise<LoyaltyResponse> => {
      const email = readLoyaltyEmail(rawQueryParam(request.url, "email"));
      return { email, points: await dependencies.loyalty.readBalance(email) };
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

      const points = readPoints(request.body);
      const limit = dependencies.pointsCharge?.(request);
      try {
        return await dependencies.checkout.startCheckout(reservationId, key, points, {
          ...(limit ? { chargePoints: limit.charge } : {}),
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 503) limit?.refund();
        throw error;
      }
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

/**
 * Parametr query odczytany z surowego URL-a. Standardowy parser zamienia `+` na spację,
 * więc `?email=delivered+jan@resend.dev` (adresy testowe Resend w Etapie III, wysłane
 * curl-em bez kodowania) stawało się „delivered jan@…” i dostawało 400. Tu `+` zostaje
 * plusem, a zakodowana spacja (`%20`) dalej jest spacją — więc zły adres nadal daje 400.
 * Powtórzony parametr → tablica (400 w walidacji), zły zapis %-kodowania → 400.
 */
function rawQueryParam(url: string, name: string): string | string[] | undefined {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const values: string[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator === -1 ? pair : pair.slice(0, separator);
    if (decodeQueryPart(key) !== name) continue;
    values.push(separator === -1 ? "" : decodeQueryPart(pair.slice(separator + 1)));
  }
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, "%2B"));
  } catch {
    throw new ValidationError("Podaj poprawny adres e-mail.");
  }
}

/**
 * Query `email` — ten sam format co przy rezerwacji, znormalizowany (trim, małe litery).
 * Powtórzony parametr (`?email=a&email=b`) przychodzi jako tablica — to też 400, nie 500.
 */
function readLoyaltyEmail(raw: unknown): string {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    throw new ValidationError("Podaj adres e-mail w parametrze email.");
  }
  if (typeof raw !== "string") {
    throw new ValidationError("Podaj dokładnie jeden adres e-mail.");
  }
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Podaj poprawny adres e-mail.");
  }
  return email;
}

/**
 * Body checkoutu jest opcjonalne; brak = 0 punktów (tryb z Etapu II).
 * Tu tylko format (400). Limit połowy ceny i saldo to reguły biznesowe (409)
 * sprawdzane w CheckoutService, bo zależą od rezerwacji i Voucherify.
 */
function readPoints(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Niepoprawne body checkoutu.");
  }
  const raw = (body as Record<string, unknown>).points;
  if (raw === undefined || raw === null) return 0;
  // isSafeInteger odrzuca też 1e300 i inne liczby, na których arytmetyka groszy przestaje być dokładna.
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ValidationError("Liczba punktów musi być nieujemną liczbą całkowitą.");
  }
  return raw;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
