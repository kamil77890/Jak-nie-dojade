import { EVENTS } from "@pas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeatMap } from "../src/components/SeatMap";

const wagon = EVENTS[0]!.wagons[0]!;

function render(taken: string[] = []): string {
  return renderToStaticMarkup(
    <SeatMap wagon={wagon} takenSeats={new Set(taken)} onSeatClick={() => undefined} />,
  );
}

function seatButton(html: string, seatNumber: number): string {
  const match = new RegExp(`<button[^>]*aria-label="Wagon 5, miejsce ${seatNumber},[^"]*"[^>]*>`).exec(
    html,
  );
  expect(match, `brak przycisku miejsca ${seatNumber}`).not.toBeNull();
  return match![0];
}

describe("karta A — mapa wagonu", () => {
  it("rysuje 20 miejsc w 5 rzędach po 4", () => {
    const html = render();
    expect(html.match(/class="seat /g)).toHaveLength(20);
    expect(html.match(/class="seat-row"/g)).toHaveLength(5);
  });

  it("oznacza okno i korytarz", () => {
    const html = render();
    expect(seatButton(html, 1)).toContain("przy oknie");
    expect(seatButton(html, 2)).toContain("przy korytarzu");
    expect(seatButton(html, 3)).toContain("przy korytarzu");
    expect(seatButton(html, 4)).toContain("przy oknie");
  });

  it("zajęte miejsca są wyszarzone i nieklikalne, wolne klikalne", () => {
    const html = render(["5-12"]);
    const taken = seatButton(html, 12);
    expect(taken).toContain("seat--occupied");
    expect(taken).toContain("disabled");

    const free = seatButton(html, 11);
    expect(free).not.toContain("seat--occupied");
    expect(free).not.toContain("disabled");
    expect(html).toContain("<strong>19</strong> wolnych");
  });
});
