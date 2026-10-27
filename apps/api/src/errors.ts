import type { ApiErrorCode } from "@pas/shared";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message?: string,
    public readonly retryAfter?: number,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export class ValidationError extends HttpError {
  constructor(message = "Nieprawidłowe dane wejściowe.") {
    super(400, "VALIDATION_ERROR", message);
  }
}

export class EventNotFoundError extends HttpError {
  constructor() {
    super(404, "EVENT_NOT_FOUND", "Nie znaleziono kursu.");
  }
}

export class EventOrSeatNotFoundError extends HttpError {
  constructor() {
    super(404, "EVENT_OR_SEAT_NOT_FOUND", "Nie znaleziono kursu lub miejsca.");
  }
}

export class SeatUnavailableError extends HttpError {
  constructor() {
    super(409, "SEAT_UNAVAILABLE", "To miejsce jest już zajęte.");
  }
}

export class ReservationNotFoundError extends HttpError {
  constructor() {
    super(404, "RESERVATION_NOT_FOUND", "Nie znaleziono rezerwacji.");
  }
}

export class ReservationExpiredError extends HttpError {
  constructor() {
    super(409, "RESERVATION_EXPIRED", "Rezerwacja wygasła — miejsce wróciło do puli.");
  }
}

export class ReservationPaidError extends HttpError {
  constructor() {
    super(409, "RESERVATION_PAID", "Ta rezerwacja jest już opłacona.");
  }
}

export class PaymentRequiredError extends HttpError {
  constructor() {
    super(402, "PAYMENT_REQUIRED", "Bilet wydajemy dopiero po płatności.");
  }
}

export class IdempotencyKeyRequiredError extends HttpError {
  constructor() {
    super(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Nagłówek Idempotency-Key jest obowiązkowy (8–100 znaków: litery, cyfry, - i _).",
    );
  }
}

export class PaymentsUnavailableError extends HttpError {
  /** Przyczyna od Stripe'a — trafia do logu serwera, nigdy do klienta. */
  constructor(retryAfter = 5, cause?: unknown) {
    super(503, "PAYMENTS_UNAVAILABLE", "Płatności chwilowo nie działają. Spróbuj za chwilę.", retryAfter);
    if (cause !== undefined) this.cause = cause;
  }
}

export class InvalidSignatureError extends HttpError {
  constructor() {
    super(400, "INVALID_SIGNATURE", "Zły podpis webhooka.");
  }
}

export class UnauthorizedError extends HttpError {
  constructor() {
    super(401, "UNAUTHORIZED", "Brak lub zły token panelu ops.");
  }
}

export class RateLimitedError extends HttpError {
  constructor(retryAfter: number) {
    super(429, "RATE_LIMITED", "Zbyt wiele żądań. Spróbuj chwilę później.", retryAfter);
  }
}

export class OverloadedError extends HttpError {
  constructor(retryAfter: number) {
    super(503, "OVERLOADED", "Kasa ma teraz szczyt. Spróbuj za chwilę.", retryAfter);
  }
}

export class BusyError extends HttpError {
  constructor(retryAfter = 1) {
    super(503, "BUSY", "Wszystkie okienka są zajęte. Spróbuj za chwilę.", retryAfter);
  }
}
