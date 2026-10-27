import {
  formatEventDate,
  formatPrice,
  formatSeatLabel,
  type Event,
  type ReservationView,
} from "@pas/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorPanel, InlineAlert, LoadingBlock } from "../components/Feedback";
import { ArrowLeft, Clock, Mail, Shield } from "../components/Icons";
import { RouteStub } from "../components/RouteStub";
import { createReservation, getEvent } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { toSummary, trainLabel, weekdayPl } from "../lib/format";
import { loadPassenger, savePassenger, saveReservation } from "../lib/session";
import { formatTtl, useReservationTtl } from "../lib/ttl";
import { useDocumentTitle } from "../hooks/useCountdown";

interface FieldErrors {
  customerName?: string;
  email?: string;
}

export function ReservePage() {
  const { eventId = "", seatId = "" } = useParams();
  const navigate = useNavigate();

  const [event, setEvent] = useState<Event | null>(null);
  const [seatTaken, setSeatTaken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [passenger, setPassenger] = useState(loadPassenger);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ttl = formatTtl(useReservationTtl());

  useDocumentTitle("Rezerwacja miejsca");

  useEffect(() => {
    let alive = true;
    // Ta sama trasa z innym kursem lub miejscem nie może pokazać starego błędu ani formularza.
    setLoading(true);
    setLoadError(null);
    setEvent(null);
    setSeatTaken(false);
    setServerError(null);
    getEvent(eventId)
      .then((result) => {
        if (!alive) return;
        setEvent(result.event);
        setSeatTaken(result.takenSeats.includes(seatId));
      })
      .catch((caught) => {
        if (alive) setLoadError(describeApiError(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [eventId, seatId]);

  if (loading) {
    return (
      <div className="page">
        <LoadingBlock label="Sprawdzamy, czy miejsce wciąż jest wolne…" />
      </div>
    );
  }

  if (loadError || !event) {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="Nie udało się wczytać kursu"
          message={loadError ?? "Wróć do rozkładu i wybierz kurs jeszcze raz."}
          action={
            <Link className="button button--ghost" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  const seat = event.wagons.flatMap((wagon) => wagon.seats).find((item) => item.id === seatId);
  if (!seat) {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="To miejsce nie istnieje"
          message={`Kurs ${trainLabel(event.id)} nie ma miejsca ${seatId}.`}
          action={
            <Link className="button button--ghost" to={`/events/${event.id}`}>
              Wróć do mapy wagonu
            </Link>
          }
        />
      </div>
    );
  }

  const seatLabel = formatSeatLabel(seat.id);

  if (seatTaken) {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="To miejsce jest już zajęte"
          message={`${seatLabel} ktoś właśnie trzyma albo kupił. Wybierz inne wolne miejsce na mapie.`}
          action={
            <Link className="button button--primary" to={`/events/${event.id}`}>
              Wróć do mapy wagonu
            </Link>
          }
        />
      </div>
    );
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (passenger.customerName.trim().length < 2) {
      errors.customerName = "Podaj imię i nazwisko — co najmniej 2 znaki.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(passenger.email.trim())) {
      errors.email = "Podaj poprawny adres e-mail, np. anna@example.com.";
    }
    return errors;
  }

  async function handleSubmit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!event || !seat || submitting) return;

    const errors = validate();
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;

    const customerName = passenger.customerName.trim();
    const email = passenger.email.trim().toLowerCase();
    setSubmitting(true);

    try {
      const created = await createReservation({
        eventId: event.id,
        seatId: seat.id,
        customerName,
        email,
      });

      savePassenger({ customerName, email });
      const view: ReservationView = {
        reservationId: created.reservationId,
        expiresAt: created.expiresAt,
        event: toSummary(event),
        seatId: seat.id,
        customerName,
        email,
        amount: created.amount,
      };
      saveReservation(view);
      navigate(`/reservations/${created.reservationId}`, { state: { reservation: view } });
    } catch (caught) {
      setServerError(describeApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <section className="reserve-hero">
        <Link className="back-link" to={`/events/${event.id}`}>
          <ArrowLeft size={16} />
          Wagon {event.wagons.find((wagon) => wagon.seats.some((item) => item.id === seat.id))?.number}
        </Link>
        <p className="eyebrow">
          Karta B · rezerwacja · {trainLabel(event.id)} · {weekdayPl(event.date)}
        </p>
        <h1>
          Miejsce <em>na Ciebie.</em>
        </h1>
        <p className="reserve-lead">
          Rezerwujesz miejsce na kurs {event.relation}. Trzymamy je {ttl} — w tym czasie płacisz{" "}
          {formatPrice(event.price)} kartą przez Stripe. Bez płatności miejsce wraca do puli.
        </p>
        <p className="reserve-date">{formatEventDate(event.date)}</p>
      </section>

      <div className="reserve-layout">
        <section className="form-card">
          <div className="form-card-head">
            <p className="eyebrow">Kto jedzie?</p>
            <p className="form-card-seat">
              {seatLabel} · <span className="form-card-price">{formatPrice(event.price)}</span>
            </p>
            <h2>Dane podróżnego</h2>
            <p>Potrzebujemy tylko imienia i adresu e-mail. Konto nie jest wymagane.</p>
          </div>

          <form onSubmit={(submitEvent) => void handleSubmit(submitEvent)} noValidate>
            <div className="field">
              <label htmlFor="customerName">Imię i nazwisko</label>
              <input
                id="customerName"
                name="customerName"
                autoComplete="name"
                maxLength={80}
                value={passenger.customerName}
                onChange={(changeEvent) => {
                  setPassenger((current) => ({ ...current, customerName: changeEvent.target.value }));
                  setFieldErrors((current) => ({ ...current, customerName: undefined }));
                }}
                aria-invalid={Boolean(fieldErrors.customerName)}
                aria-describedby={fieldErrors.customerName ? "customerName-error" : undefined}
                placeholder="Anna Kowalska"
              />
              {fieldErrors.customerName ? (
                <p className="field-error" id="customerName-error">
                  {fieldErrors.customerName}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="email">Adres e-mail</label>
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={160}
                value={passenger.email}
                onChange={(changeEvent) => {
                  setPassenger((current) => ({ ...current, email: changeEvent.target.value }));
                  setFieldErrors((current) => ({ ...current, email: undefined }));
                }}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "email-error" : "email-hint"}
                placeholder="anna@example.com"
              />
              {fieldErrors.email ? (
                <p className="field-error" id="email-error">
                  {fieldErrors.email}
                </p>
              ) : (
                <p className="field-hint" id="email-hint">
                  Na ten adres wyślemy potwierdzenie. Bilet zobaczysz na ekranie zaraz po płatności.
                </p>
              )}
            </div>

            {serverError ? <InlineAlert>{serverError}</InlineAlert> : null}

            <div className="form-submit">
              <button
                type="submit"
                className="button button--primary button--wide button--xl"
                disabled={submitting}
                aria-busy={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner spinner--dark" aria-hidden="true" />
                    Trzymamy miejsce…
                  </>
                ) : (
                  <>
                    <Clock size={19} />
                    Rezerwuję na {ttl}
                  </>
                )}
              </button>
              <p className="form-note">
                <Shield size={15} />
                Rezerwacja jest ważna {ttl}. Danych karty nie widzimy — płacisz na stronie Stripe'a.
              </p>
            </div>
          </form>
        </section>

        <div className="reserve-aside">
          <RouteStub event={toSummary(event)} seatId={seat.id} label="Rezerwacja" />

          <section className="aside-card">
            <p className="eyebrow">Co dalej?</p>
            <ol className="next-steps">
              <li>
                <span>01</span>
                <div>
                  <strong>Zobaczysz licznik</strong>
                  <p>Pokazuje czas z serwera, nie z zegara przeglądarki.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Klikniesz „Zapłać {formatPrice(event.price)}”</strong>
                  <p>Przejdziesz na stronę Stripe'a. Po zapłacie wracasz po bilet z kodem.</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>E-mail poleci w tle</strong>
                  <p>Kolejka zajmie się potwierdzeniem, nawet jeśli poczta zwolni.</p>
                </div>
              </li>
            </ol>
            <p className="aside-footnote">
              <Mail size={14} />
              E-mail nie blokuje wydania biletu.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
