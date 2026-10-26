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
