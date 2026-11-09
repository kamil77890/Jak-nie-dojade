import { formatDuration, formatEventDate, formatPrice, getSeat, type EventSummary } from "@pas/shared";
import { splitRelation } from "../lib/format";
import { TrainBadge } from "./TrainBadge";

/** Te same dane kursu na ekranie rezerwacji, licznika i biletu. */
export function TripSummary({
  event,
  seatId,
  passenger,
  price,
}: {
  event: EventSummary;
  seatId: string;
  passenger?: string;
  /** Kwota w groszach i jej etykieta, np. ["Cena", 8900] albo ["Do zapłaty", 8900]. */
  price?: [string, number];
}) {
  const { from, to } = splitRelation(event.relation);
  const position = getSeat(event.id, seatId)?.position;

  const rows: Array<[string, string]> = [
    ["Data", formatEventDate(event.date)],
    ["W podróży", formatDuration(event.departureTime, event.arrivalTime)],
  ];
  if (position) rows.push(["Miejsce", position === "window" ? "przy oknie" : "przy korytarzu"]);
  if (passenger) rows.push(["Podróżny", passenger]);
  if (price) rows.push([price[0], formatPrice(price[1])]);

  return (
    <dl className="text-[16px]">
      <div className="trip-route flex gap-5 pb-5">
        <dt className="sr-only">Trasa</dt>
        <dd className="relative flex flex-col gap-4 pl-6">
          <span className="absolute bottom-3 left-[5px] top-3 w-[2px] rounded-full bg-line" aria-hidden="true" />
          {[
            [event.departureTime, from],
            [event.arrivalTime, to],
          ].map(([time, station], index) => (
            <span key={time} className="relative flex items-baseline gap-3">
              <span
                className={`absolute -left-6 top-[7px] size-3 rounded-full border-2 ${
                  index === 0 ? "border-accent bg-accent" : "border-ink bg-surface"
                }`}
                aria-hidden="true"
              />
              <strong className="text-[22px] font-extrabold narrow">{time}</strong>
              <span>{station}</span>
            </span>
          ))}
        </dd>
        <TrainBadge eventId={event.id} className="ml-auto self-start" />
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 border-t border-line py-3">
          <dt className="text-muted">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
