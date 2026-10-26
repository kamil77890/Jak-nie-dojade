import {
  formatDuration,
  formatEventDate,
  type EventDetailResponse,
  type Seat,
} from "@pas/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ErrorPanel, InlineAlert, LoadingBlock } from "../components/Feedback";
import { ArrowLeft, Refresh } from "../components/Icons";
import { SeatMap } from "../components/SeatMap";
import { getEvent } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { freeSeatsWord, splitRelation, toSummary, trainLabel, weekdayPl } from "../lib/format";
import { useDocumentTitle } from "../hooks/useCountdown";
import { EASE, gsap, useGsap } from "../lib/motion";

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
  const root = useRef<HTMLDivElement>(null);

  useDocumentTitle(data ? data.event.relation : "Kurs");

  useGsap(
    root,
    () => {
      gsap.from(".intro", { y: 36, opacity: 0, duration: 1.2, stagger: 0.08, ease: EASE });
    },
    [Boolean(data)],
  );

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
      <div className="mx-auto max-w-[1320px] px-4 sm:px-8">
        <LoadingBlock label="Wczytujemy plan wagonów…" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
        <ErrorPanel
          title="Nie udało się wczytać kursu"
          message={error ?? "Tego kursu nie ma w rozkładzie."}
          onRetry={() => void load("initial")}
          action={
            <Link className="btn btn-ghost" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </div>
    );
  }

  const { event, takenSeats } = data;
  const { from, to } = splitRelation(event.relation);
  const taken = new Set(takenSeats);
  const wagon = event.wagons.find((item) => item.id === wagonId) ?? event.wagons[0];

  function handleSeatClick(seat: Seat) {
    navigate(`/events/${event.id}/reserve/${seat.id}`, {
      state: { eventSummary: toSummary(event), seatLabel: seat.id },
      viewTransition: true,
    });
  }

  return (
    <div ref={root} className="mx-auto max-w-[1320px] px-4 pb-24 pt-10 sm:px-8">
      <Link className="inline-flex items-center gap-2 text-[15px] font-semibold text-muted transition-colors hover:text-ink" to="/" viewTransition>
        <ArrowLeft size={16} />
        Odjazdy
      </Link>

      <header className="mt-8 grid gap-8 border-b border-line pb-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="intro flex flex-wrap items-center gap-3 text-[15px] text-muted">
            <span className="train-badge">{trainLabel(event.id)}</span>
            <span>
              {weekdayPl(event.date)}, {formatEventDate(event.date)}
            </span>
          </p>

          <h1 className="mt-6 grid gap-1" aria-label={`${event.relation}, odjazd ${event.departureTime}, przyjazd ${event.arrivalTime}`}>
            {[
              [event.departureTime, from],
              [event.arrivalTime, to],
            ].map(([time, station]) => (
              <span key={time} className="intro grid items-baseline gap-x-6 sm:grid-cols-[minmax(170px,auto)_minmax(0,1fr)]">
                <span className="text-[clamp(56px,8vw,104px)] font-extrabold leading-[0.95] narrow">{time}</span>
                <span className="text-[clamp(26px,3.6vw,46px)] font-bold leading-tight condensed">{station}</span>
              </span>
            ))}
          </h1>
        </div>

        <p className="intro text-[16px] text-muted lg:text-right">
          W podróży {formatDuration(event.departureTime, event.arrivalTime)}.
          <br className="hidden lg:block" /> Bilet na całą trasę.
        </p>
      </header>

      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2 rounded-full border border-line bg-surface p-1.5" role="tablist" aria-label="Wybierz wagon">
          {event.wagons.map((item) => {
            const free = item.seats.filter((seat) => !taken.has(seat.id)).length;
            const active = item.id === wagon?.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`flex items-center gap-3 rounded-full py-1.5 pl-1.5 pr-5 text-left transition-colors duration-300 ${
                  active ? "bg-ink text-bg" : "hover:bg-raised"
                }`}
                onClick={() => setWagonId(item.id)}
              >
                <span
                  className={`grid size-10 place-items-center rounded-full text-[22px] font-extrabold narrow ${
                    active ? "bg-accent text-black" : "bg-raised"
                  }`}
                >
                  {item.number}
                </span>
                <span className="flex flex-col leading-tight">
                  <span className="text-[15px] font-semibold">Wagon {item.number}</span>
                  <small className={`text-[13px] ${active ? "text-bg/70" : "text-muted"}`}>
                    {free} {freeSeatsWord(free)}
                  </small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[14px] text-muted">
            {lastUpdated
              ? `Stan z ${new Date(lastUpdated).toLocaleTimeString("pl-PL", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : ""}
          </span>
          <button
            type="button"
            className="btn btn-ghost min-h-10 px-4 text-[14px]"
            onClick={() => void load("refresh")}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <Refresh size={15} className={refreshing ? "animate-spin" : ""} />
            Odśwież
          </button>
        </div>
      </div>

      {refreshError ? (
        <InlineAlert tone="warning">
          Nie udało się odświeżyć planu: {refreshError} Widzisz ostatni znany stan.
        </InlineAlert>
      ) : null}

      <div className="mt-6">
        {wagon ? <SeatMap wagon={wagon} takenSeats={taken} onSeatClick={handleSeatClick} /> : null}
      </div>

      <p className="mt-6 max-w-[64ch] text-[15px] text-muted">
        Kliknij wolne miejsce, żeby je zarezerwować. Zakreskowane miejsca są już kupione albo ktoś
        właśnie je trzyma. Plan odświeża się sam, gdy wracasz na tę kartę.
      </p>
    </div>
  );
}
