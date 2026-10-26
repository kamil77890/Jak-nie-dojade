import {
  DEMO_SEAT_COUNT,
  formatDuration,
  formatEventDate,
  type EventSummary,
} from "@pas/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { EmptyPanel, ErrorPanel } from "../components/Feedback";
import { ArrowUpRight, Clock, Shield, Spark, Ticket } from "../components/Icons";
import { getEvents } from "../lib/api";
import { describeApiError } from "../lib/errors";
import {
  dayOfMonth,
  monthShortPl,
  trainLabel,
  weekdayPl,
  yearOfDate,
} from "../lib/format";
import { useDocumentTitle } from "../hooks/useCountdown";

export function EventsPage() {
  useDocumentTitle("Rozkład jazdy");
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await getEvents());
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="eyebrow-rule" aria-hidden="true" />
            Projekt PAS · Etap I · Wariant Pociąg
          </p>
          <h1>
            Dokąd
            <br />
            <em>jedziemy?</em>
          </h1>
          <p className="hero-lead">
            Wybierz kurs, zajmij miejsce i trzymaj je piętnaście minut. Bez konta, bez karty — kod
            biletu dostajesz od razu, a miejsce wraca do puli, jeśli się rozmyślisz.
          </p>
          <div className="hero-actions">
            <a className="button button--primary" href="#kursy">
              Zobacz rozkład
              <ArrowUpRight size={17} />
            </a>
            <Link className="text-link" to="/lab">
              Jak kasa znosi awarie?
              <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>

        <aside className="hero-card" aria-label="Założenia etapu">
          <p className="card-kicker">Zasada nr 1</p>
          <p className="hero-card-quote">
            Każdy zaczyna od zaślepki. Integrujemy dopiero wtedy, gdy karta jest gotowa.
          </p>
          <dl className="hero-facts">
            <div>
              <dt>Kursy</dt>
              <dd>03</dd>
            </div>
            <div>
              <dt>Wagony</dt>
              <dd>02</dd>
            </div>
            <div>
              <dt>Rezerwacja</dt>
              <dd>15 min</dd>
            </div>
            <div>
              <dt>Płatności</dt>
              <dd>Etap II</dd>
            </div>
          </dl>
          <p className="hero-card-foot">
            <Shield size={14} />
            Limit, kolejka i bezpiecznik działają w tle.
          </p>
        </aside>
      </section>

      <section className="schedule" id="kursy" aria-labelledby="schedule-title">
        <div className="section-head">
          <div>
            <p className="eyebrow">Karta A · rozkład i mapa</p>
            <h2 id="schedule-title">Najbliższe kursy</h2>
          </div>
          <p className="section-meta">
            {events ? `${events.length} połączenia · ${DEMO_SEAT_COUNT} miejsc` : "Ładujemy rozkład"}
          </p>
        </div>

        {loading && !events ? (
          <div className="events-list" aria-busy="true" aria-label="Ładowanie kursów">
            {[0, 1, 2].map((item) => (
              <div className="event-card event-card--skeleton" key={item}>
                <span className="skeleton skeleton-date" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-arrow" />
              </div>
            ))}
          </div>
        ) : null}

        {error ? (
          <ErrorPanel
            title="Rozkład nie odpowiada"
            message={error}
            onRetry={() => void load()}
          />
        ) : null}

        {!error && events && events.length === 0 ? (
          <EmptyPanel
            title="Na razie pusto na peronie"
            message="Nie ma żadnych kursów w rozkładzie. Wróć za chwilę."
          />
        ) : null}

        {!error && events && events.length > 0 ? (
          <div className="events-list">
            {events.map((event, index) => (
              <Link
                className="event-card"
                to={`/events/${event.id}`}
                key={event.id}
                style={{ animationDelay: `${index * 70}ms` }}
              >
                <div className="event-date" aria-hidden="true">
                  <span className="event-day">{dayOfMonth(event.date)}</span>
                  <span className="event-month">{monthShortPl(event.date)}</span>
                  <span className="event-year">{yearOfDate(event.date)}</span>
                </div>

                <div className="event-body">
                  <p className="event-kicker">
                    <span>{trainLabel(event.id)}</span>
                    <span className="event-dot" aria-hidden="true" />
                    {weekdayPl(event.date)}
                  </p>
                  <h3>{event.relation}</h3>
                  <p className="event-times">
                    <strong>{event.departureTime}</strong>
                    <span className="event-track" aria-hidden="true">
                      <span />
                    </span>
                    <strong>{event.arrivalTime}</strong>
                    <span className="event-duration">
                      <Clock size={14} />
                      {formatDuration(event.departureTime, event.arrivalTime)}
                    </span>
                  </p>
                  <p className="event-date-long">{formatEventDate(event.date)}</p>
                </div>

                <div className="event-meta">
                  <span>2 wagony</span>
                  <span>40 miejsc</span>
                  <span className="event-meta-highlight">wolne</span>
                </div>

                <span className="event-arrow" aria-hidden="true">
                  <ArrowUpRight size={22} />
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      <section className="how-it-works" aria-labelledby="how-title">
        <div className="section-head section-head--compact">
          <div>
            <p className="eyebrow">Trzy karty, jeden przepływ</p>
            <h2 id="how-title">Od peronu do kodu</h2>
          </div>
        </div>
        <div className="steps-grid">
          <article className="step-card">
            <span className="step-number">01</span>
            <Ticket size={22} />
            <h3>Wybierz kurs i miejsce</h3>
            <p>Rozkład i mapa wagonu. Zajęte miejsca są wyszarzone, wolne prowadzą dalej.</p>
          </article>
          <article className="step-card">
            <span className="step-number">02</span>
            <Clock size={22} />
            <h3>Zarezerwuj na 15 minut</h3>
            <p>Imię i e-mail wystarczą. Licznik pokazuje czas serwera, nie zegar przeglądarki.</p>
          </article>
          <article className="step-card">
            <span className="step-number">03</span>
            <Spark size={22} />
            <h3>Odbierz kod biletu</h3>
            <p>Klik „Kupuję bilet” wydaje kod. Potwierdzenie e-mail leci w tle przez kolejkę.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
