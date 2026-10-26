import {
  formatDuration,
  formatEventDate,
  formatSeatLabel,
  type EventDetailResponse,
  type Seat,
} from "@pas/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ErrorPanel, InlineAlert, LoadingBlock } from "../components/Feedback";
import { ArrowLeft, ArrowUpRight, Clock, Refresh, Seat as SeatIcon, Shield } from "../components/Icons";
import { SeatMap } from "../components/SeatMap";
import { getEvent } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { seatsInWagonLabel, toSummary, trainLabel, wagonsLabel, weekdayPl } from "../lib/format";
import { formatTtl, useReservationTtl } from "../lib/ttl";
import { useDocumentTitle } from "../hooks/useCountdown";

export function EventPage() {
  const { eventId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [data, setData] = useState<EventDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [wagonId, setWagonId] = useState<string | null>(null);
  const lastLocationKey = useRef(location.key);

  useDocumentTitle(data ? data.event.relation : "Kurs");
  const ttl = formatTtl(useReservationTtl());

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);

      try {
        const result = await getEvent(eventId);
        setData(result);
        setError(null);
        setRefreshError(null);
        setLastUpdated(Date.now());
        setWagonId((current) => {
          if (current && result.event.wagons.some((wagon) => wagon.id === current)) return current;
          return result.event.wagons[0]?.id ?? null;
        });
      } catch (caught) {
        if (mode === "initial") setError(describeApiError(caught));
        else setRefreshError(describeApiError(caught));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [eventId],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void load("refresh");
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load("refresh");
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // Powrót z formularza B zmienia location.key — mapa od razu widzi nową rezerwację.
  useEffect(() => {
    if (lastLocationKey.current === location.key) return;
    lastLocationKey.current = location.key;
    void load("refresh");
  }, [location.key, load]);

  if (loading && !data) {
    return (
      <div className="page">
        <LoadingBlock label="Ustawiamy peron i sprawdzamy miejsca…" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="Ten kurs nie wyjechał"
          message={error ?? "Nie znaleźliśmy tego kursu w rozkładzie."}
          onRetry={() => void load("initial")}
          action={
            <Link className="button button--ghost" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  const { event, takenSeats } = data;
  const taken = new Set(takenSeats);
  const wagon = event.wagons.find((item) => item.id === wagonId) ?? event.wagons[0];
  const totalSeats = event.wagons.reduce((count, item) => count + item.seats.length, 0);
  const totalFree = event.wagons.reduce(
    (count, item) => count + item.seats.filter((seat) => !taken.has(seat.id)).length,
    0,
  );

  function handleSeatClick(seat: Seat) {
    navigate(`/events/${event.id}/reserve/${seat.id}`, {
      state: { eventSummary: toSummary(event), seatLabel: formatSeatLabel(seat.id) },
    });
  }

  return (
    <div className="page">
      <section className="course-hero">
        <Link className="back-link" to="/">
          <ArrowLeft size={16} />
          Rozkład jazdy
        </Link>

        <div className="course-hero-grid">
          <div className="course-title">
            <p className="eyebrow">
              Karta A · {trainLabel(event.id)} · {weekdayPl(event.date)}
            </p>
            <h1>{event.relation}</h1>
            <p className="course-sub">{formatEventDate(event.date)}</p>
          </div>

          <div className="course-times" aria-label="Godziny kursu">
            <div>
              <span>Odjazd</span>
              <strong>{event.departureTime}</strong>
            </div>
            <span className="course-rail" aria-hidden="true">
              <span />
            </span>
            <div>
              <span>Przyjazd</span>
              <strong>{event.arrivalTime}</strong>
            </div>
            <span className="course-duration">
              <Clock size={14} />
              {formatDuration(event.departureTime, event.arrivalTime)}
            </span>
          </div>
        </div>

        <div className="course-facts">
          <span>
            <SeatIcon size={15} />
            {totalFree} z {totalSeats} miejsc wolnych
          </span>
          <span>{wagonsLabel(event.wagons.length)} · miejsca numerowane</span>
          <span>Bilet na całą trasę</span>
        </div>
      </section>

      <div className="map-toolbar">
        <div className="wagon-switch" role="tablist" aria-label="Wybierz wagon">
          {event.wagons.map((item) => {
            const free = item.seats.filter((seat) => !taken.has(seat.id)).length;
            const active = item.id === wagon?.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`wagon-tab ${active ? "is-active" : ""}`}
                onClick={() => setWagonId(item.id)}
              >
                <span>Wagon {item.number}</span>
                <small>
                  {free} / {item.seats.length} wolnych
                </small>
              </button>
            );
          })}
        </div>

        <div className="refresh-box">
          <span className="refresh-stamp">
            {lastUpdated
              ? `Zaktualizowano ${new Date(lastUpdated).toLocaleTimeString("pl-PL", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : "Świeże dane z serwera"}
          </span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void load("refresh")}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <Refresh size={15} className={refreshing ? "spin" : ""} />
            Odśwież
          </button>
        </div>
      </div>

      {refreshError ? (
        <InlineAlert tone="warning">
          Nie udało się odświeżyć mapy: {refreshError} Pokazujemy ostatni znany stan.
        </InlineAlert>
      ) : null}

      <div className="map-layout">
        {wagon ? (
          <SeatMap
            wagon={wagon}
            takenSeats={taken}
            onSeatClick={handleSeatClick}
          />
        ) : null}

        <aside className="map-aside">
          <section className="aside-card aside-card--accent">
            <p className="eyebrow">Wybór miejsca</p>
            <h2>Kliknij wolne miejsce</h2>
            <p>
              Otworzy się formularz z numerem miejsca. Rezerwacja trzyma je {ttl} — potem wraca do
              puli.
            </p>
            <ul className="aside-list">
              <li>
                <span className="ascii-seat" aria-hidden="true" />
                Pasek przy krawędzi oznacza miejsce przy oknie.
              </li>
              <li>
                <span className="ascii-seat ascii-seat--taken" aria-hidden="true" />
                Wyszarzone miejsce jest kupione albo właśnie trzymane.
              </li>
              <li>
                <Refresh size={16} />
                Mapa odświeża się po powrocie z formularza i na focus.
              </li>
            </ul>
            <p className="aside-footnote">{seatsInWagonLabel(wagon?.seats.length ?? 20)} w wagonie</p>
          </section>

          <section className="aside-card">
            <p className="eyebrow">Bezpieczniki w tle</p>
            <h2>Kasa nie padnie przez e-mail</h2>
            <p>
              Zakup i kod biletu są lokalne. Potwierdzenie idzie do kolejki, a dostawca poczty ma
              timeout, retry i bezpiecznik.
            </p>
            <Link className="text-link" to="/lab">
              Zobacz laboratorium
              <ArrowUpRight size={15} />
            </Link>
            <p className="aside-footnote">
              <Shield size={14} />
              E04 · E05 · E06
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
