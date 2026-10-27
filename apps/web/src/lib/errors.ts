import { ApiRequestError } from "./api";

/** Dosłowny komunikat z karty C — licznik na zerze i 409 pokazują ten sam tekst. */
export const RESERVATION_EXPIRED_MESSAGE = "Rezerwacja wygasła — miejsce wróciło do puli.";

export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return "Coś się nie udało. Spróbuj jeszcze raz.";
  }

  switch (error.code) {
    case "RATE_LIMITED":
      return `Zwolnij na chwilę — zbyt wiele prób. Spróbuj za ${error.retryAfter ?? 30} s.`;
    case "OVERLOADED":
      return `Kasa ma teraz szczyt. Spróbuj za ${error.retryAfter ?? 5} s.`;
    case "BUSY":
      return "Wszystkie okienka są zajęte. Spróbuj za chwilę.";
    case "SEAT_UNAVAILABLE":
      return "Ktoś był szybszy — to miejsce właśnie zniknęło z mapy.";
    case "RESERVATION_EXPIRED":
      return RESERVATION_EXPIRED_MESSAGE;
    case "EVENT_NOT_FOUND":
    case "EVENT_OR_SEAT_NOT_FOUND":
      return "Nie znaleźliśmy tego kursu albo miejsca. Wróć do rozkładu.";
    case "RESERVATION_NOT_FOUND":
      return "Nie znaleźliśmy tej rezerwacji. Zacznij od wyboru miejsca.";
    case "RESERVATION_PAID":
      return "Ta rezerwacja jest już opłacona — bilet czeka.";
    case "PAYMENT_REQUIRED":
      return "Bilet wydamy po płatności. Kliknij „Zapłać”.";
    case "PAYMENTS_UNAVAILABLE":
      return "Płatności chwilowo nie działają. Rezerwacja trwa — spróbuj za chwilę.";
    case "IDEMPOTENCY_KEY_REQUIRED":
      return "Nie udało się przygotować płatności. Odśwież stronę i spróbuj jeszcze raz.";
    case "VALIDATION_ERROR":
      return "Sprawdź dane w formularzu i spróbuj jeszcze raz.";
    case "NETWORK_ERROR":
      return "Nie ma połączenia z kasą. Sprawdź, czy API działa.";
    default:
      return "Coś się nie udało. Spróbuj jeszcze raz.";
  }
}
