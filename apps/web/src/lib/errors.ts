import { ApiRequestError } from "./api";

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
      return "Rezerwacja wygasła — miejsce wróciło do puli.";
    case "EVENT_NOT_FOUND":
    case "EVENT_OR_SEAT_NOT_FOUND":
      return "Nie znaleźliśmy tego kursu albo miejsca. Wróć do rozkładu.";
    case "RESERVATION_NOT_FOUND":
      return "Nie znaleźliśmy tej rezerwacji. Zacznij od wyboru miejsca.";
    case "VALIDATION_ERROR":
      return "Sprawdź dane w formularzu i spróbuj jeszcze raz.";
    case "NETWORK_ERROR":
      return "Nie ma połączenia z kasą. Sprawdź, czy API działa.";
    default:
      return "Coś się nie udało. Spróbuj jeszcze raz.";
  }
}
