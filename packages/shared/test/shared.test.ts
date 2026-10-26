import { describe, expect, it } from "vitest";
import {
  DEMO_SEAT_COUNT,
  EVENTS,
  formatCountdown,
  formatDuration,
  formatEventDate,
  formatSeatLabel,
  getSeat,
  isReservationActive,
  parseSeatId,
  ttlMsFromEnv,
} from "../src/index";

describe("TTL", () => {
  it("domyślnie trzyma miejsce 15 minut", () => {
    expect(ttlMsFromEnv({})).toBe(15 * 60_000);
  });

  it("pozwala nadpisać TTL sekundami na potrzeby testów", () => {
    expect(ttlMsFromEnv({ RESERVATION_TTL_SECONDS: "20" })).toBe(20_000);
    expect(ttlMsFromEnv({ RESERVATION_TTL_MINUTES: "2" })).toBe(120_000);
  });

  it("ignoruje śmieci i wartości ujemne", () => {
    expect(ttlMsFromEnv({ RESERVATION_TTL_SECONDS: "-5" })).toBe(15 * 60_000);
    expect(ttlMsFromEnv({ RESERVATION_TTL_MINUTES: "abc" })).toBe(15 * 60_000);
  });
});

describe("isReservationActive", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");

  it("aktywna i niewygasła rezerwacja jest ważna", () => {
    expect(isReservationActive({ status: "active", expiresAt: "2026-10-26T12:01:00.000Z" }, now)).toBe(true);
  });

  it("wygasła, zakupiona i uszkodzona data nie są ważne", () => {
    expect(isReservationActive({ status: "active", expiresAt: "2026-10-26T11:59:00.000Z" }, now)).toBe(false);
    expect(isReservationActive({ status: "purchased", expiresAt: "2026-10-26T12:01:00.000Z" }, now)).toBe(false);
    expect(isReservationActive({ status: "active", expiresAt: "nie-data" }, now)).toBe(false);
  });
});

describe("etykiety", () => {
  it("składa etykietę miejsca z identyfikatora", () => {
    expect(parseSeatId("5-12")).toEqual({ wagonNumber: 5, seatNumber: 12 });
    expect(formatSeatLabel("5-12")).toBe("Wagon 5, miejsce 12");
    expect(formatSeatLabel("bez-formatu")).toBe("bez-formatu");
  });

  it("formatuje datę po polsku", () => {
    expect(formatEventDate("2026-11-21")).toBe("21 listopada 2026");
  });

  it("liczy czas przejazdu", () => {
    expect(formatDuration("08:10", "10:55")).toBe("2 godz. 45 min");
    expect(formatDuration("23:30", "01:00")).toBe("1 godz. 30 min");
  });

  it("formatuje countdown", () => {
    expect(formatCountdown(14 * 60_000 + 32_000)).toBe("14:32");
    expect(formatCountdown(3_661_000)).toBe("1:01:01");
    expect(formatCountdown(-1)).toBe("00:00");
  });
});

describe("fixtures", () => {
  it("mają 3 kursy, po 2 wagony i 20 miejsc", () => {
    expect(EVENTS).toHaveLength(3);
    expect(DEMO_SEAT_COUNT).toBe(120);
    for (const event of EVENTS) {
      expect(event.wagons).toHaveLength(2);
      for (const wagon of event.wagons) {
        expect(wagon.seats).toHaveLength(20);
      }
    }
  });

  it("nadają pozycję okno/korytarz z numeru miejsca", () => {
    const event = EVENTS[0]!;
    const seats = event.wagons[0]!.seats;
    expect(seats[0]?.position).toBe("window");
    expect(seats[1]?.position).toBe("aisle");
    expect(seats[2]?.position).toBe("aisle");
    expect(seats[3]?.position).toBe("window");
    expect(seats[4]?.position).toBe("window");
  });

  it("znajdują miejsce po pełnym ID", () => {
    expect(getSeat("ic-7310-2026-11-21", "5-12")?.number).toBe(12);
    expect(getSeat("ic-7310-2026-11-21", "5-99")).toBeUndefined();
  });
});
