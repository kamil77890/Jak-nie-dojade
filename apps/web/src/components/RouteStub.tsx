import {
  formatDuration,
  formatEventDate,
  formatSeatLabel,
  type EventSummary,
} from "@pas/shared";
import { trainLabel } from "../lib/format";

export function RouteStub({
  event,
  seatId,
  passenger,
  label = "Twój bilet",
}: {
  event: EventSummary;
  seatId: string;
  passenger?: string;
  label?: string;
}) {
  return (
    <aside className="route-stub" aria-label="Podsumowanie biletu">
      <p className="stub-kicker">{label}</p>
      <p className="stub-train">{trainLabel(event.id)}</p>
      <h2 className="stub-relation">{event.relation}</h2>

      <div className="stub-times">
        <div>
          <span className="stub-label">Odjazd</span>
          <strong>{event.departureTime}</strong>
        </div>
        <span className="stub-track" aria-hidden="true">
          <span />
        </span>
        <div className="is-right">
          <span className="stub-label">Przyjazd</span>
          <strong>{event.arrivalTime}</strong>
        </div>
      </div>

      <dl className="stub-meta">
        <div>
          <dt>Data</dt>
          <dd>{formatEventDate(event.date)}</dd>
        </div>
        <div>
          <dt>Miejsce</dt>
          <dd>{formatSeatLabel(seatId)}</dd>
        </div>
        <div>
          <dt>W podróży</dt>
          <dd>{formatDuration(event.departureTime, event.arrivalTime)}</dd>
        </div>
        {passenger ? (
          <div>
            <dt>Podróżny</dt>
            <dd>{passenger}</dd>
          </div>
        ) : null}
      </dl>

      <p className="stub-note">
        Bilet na całą trasę. Bez przesiadek i bez miejsc stojących.
      </p>
    </aside>
  );
}
