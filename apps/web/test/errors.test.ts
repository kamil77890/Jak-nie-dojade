import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/lib/api";
import { describeApiError } from "../src/lib/errors";

describe("describeApiError — komunikat z koperty API", () => {
  it("VALIDATION_ERROR pokazuje konkretny komunikat z API, a bez niego ogólnik", () => {
    expect(describeApiError(new ApiRequestError(400, "VALIDATION_ERROR", undefined, "Podaj poprawny adres e-mail."))).toBe(
      "Podaj poprawny adres e-mail.",
    );
    expect(describeApiError(new ApiRequestError(400, "VALIDATION_ERROR"))).toBe(
      "Sprawdź dane w formularzu i spróbuj jeszcze raz.",
    );
  });

  it("nieznany kod bierze komunikat z API; znany kod zostaje przy tekście frontu", () => {
    expect(describeApiError(new ApiRequestError(409, "NOWY_KOD", undefined, "Komunikat z serwera."))).toBe(
      "Komunikat z serwera.",
    );
    expect(
      describeApiError(new ApiRequestError(409, "INSUFFICIENT_POINTS", undefined, "Masz za mało punktów.")),
    ).toBe("Masz za mało punktów. Zmniejsz liczbę punktów albo zapłać całość kartą.");
  });
});
