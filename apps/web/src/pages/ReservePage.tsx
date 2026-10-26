import { formatSeatLabel, type Event, type ReservationView } from "@pas/shared";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ErrorPanel, InlineAlert, LoadingBlock } from "../components/Feedback";
import { ArrowLeft } from "../components/Icons";
import { TripSummary } from "../components/TripSummary";
import { createReservation, getEvent } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { toSummary, trainLabel } from "../lib/format";
import { EASE, gsap, useGsap } from "../lib/motion";
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
  const root = useRef<HTMLDivElement>(null);

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
    setLoading(true);
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

  useGsap(
    root,
    () => {
      gsap.from(".seat-digit", { yPercent: 110, duration: 1.3, stagger: 0.12, ease: EASE });
      gsap.from(".intro", { y: 40, opacity: 0, duration: 1.2, stagger: 0.08, ease: EASE, delay: 0.15 });
    },
    [Boolean(event), seatTaken],
  );

  const seat = event?.wagons.flatMap((wagon) => wagon.seats).find((item) => item.id === seatId);

  if (loading) {
    return (
      <Frame>
        <LoadingBlock label="Sprawdzamy, czy miejsce jest wolne…" />
      </Frame>
    );
  }

  if (loadError || !event) {
    return (
      <Frame narrow>
        <ErrorPanel
          title="Nie udało się wczytać kursu"
          message={loadError ?? "Wróć do odjazdów i wybierz kurs jeszcze raz."}
          action={
            <Link className="btn btn-ghost" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </Frame>
    );
  }

  if (!seat) {
    return (
      <Frame narrow>
        <ErrorPanel
          title="To miejsce nie istnieje"
          message={`Kurs ${trainLabel(event.id)} nie ma miejsca ${seatId}.`}
          action={
            <Link className="btn btn-ghost" to={`/events/${event.id}`} viewTransition>
              Wróć do planu wagonu
            </Link>
          }
        />
      </Frame>
    );
  }

  const seatLabel = formatSeatLabel(seat.id);

  if (seatTaken) {
    return (
      <Frame narrow>
        <ErrorPanel
          title="To miejsce jest już zajęte"
          message={`${seatLabel} jest już kupione albo ktoś je właśnie trzyma. Wybierz inne wolne miejsce na planie.`}
          action={
            <Link className="btn btn-primary" to={`/events/${event.id}`} viewTransition>
              Wróć do planu wagonu
            </Link>
          }
        />
      </Frame>
    );
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (passenger.customerName.trim().length < 2) {
      errors.customerName = "Wpisz imię i nazwisko, co najmniej 2 znaki.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(passenger.email.trim())) {
      errors.email = "Wpisz adres e-mail w formie anna@example.com.";
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
      };
      saveReservation(view);
      navigate(`/reservations/${created.reservationId}`, {
        state: { reservation: view },
        viewTransition: true,
      });
    } catch (caught) {
      setServerError(describeApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const wagonNumber = seat.id.split("-")[0];

  return (
    <div ref={root}>
      <Frame>
        <Link className="inline-flex items-center gap-2 text-[15px] font-semibold text-muted transition-colors hover:text-ink" to={`/events/${event.id}`} viewTransition>
          <ArrowLeft size={16} />
          Plan wagonu
        </Link>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-2 lg:gap-8">
          <section className="relative overflow-hidden rounded-[28px] bg-accent p-7 text-black sm:p-10" aria-labelledby="seat-title">
            <h1 id="seat-title" className="flex gap-10 sm:gap-14" aria-label={`Twoje miejsce: ${seatLabel}`}>
              {[
                ["Wagon", wagonNumber],
                ["Miejsce", String(seat.number)],
              ].map(([label, value]) => (
                <span key={label} className="flex flex-col">
                  <small className="text-[16px] font-semibold">{label}</small>
                  <span className="overflow-hidden">
                    <span className="seat-digit block text-[clamp(96px,12vw,168px)] font-extrabold leading-[0.85] narrow">
                      {value}
                    </span>
                  </span>
                </span>
              ))}
            </h1>
            <p className="intro mt-6 border-t-2 border-black/80 pt-5 text-[20px] font-bold">{seatLabel}</p>
            <div className="intro mt-6 rounded-2xl bg-white/85 p-5 text-ink [--c-ink:#0b0d10] [--c-line:rgb(11_13_16/0.1)] [--c-muted:#5a616c] [--c-surface:#fff]">
              <TripSummary event={toSummary(event)} seatId={seat.id} />
            </div>
          </section>

          <section className="intro card p-7 sm:p-10" aria-labelledby="form-title">
            <h2 id="form-title" className="text-[clamp(34px,3.8vw,48px)] font-extrabold leading-none condensed">
              Kto jedzie?
            </h2>
            <p className="mt-3 max-w-[44ch] text-muted">
              Wystarczy imię i e-mail. Na ten adres wyślemy potwierdzenie, a bilet zobaczysz od razu
              na ekranie.
            </p>

            <form className="mt-8 space-y-5" onSubmit={(submitEvent) => void handleSubmit(submitEvent)} noValidate>
              <Field id="customerName" label="Imię i nazwisko" error={fieldErrors.customerName}>
                <input
                  id="customerName"
                  name="customerName"
                  autoComplete="name"
                  maxLength={80}
                  className="field-input"
                  value={passenger.customerName}
                  onChange={(changeEvent) => {
                    setPassenger((current) => ({ ...current, customerName: changeEvent.target.value }));
                    setFieldErrors((current) => ({ ...current, customerName: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.customerName)}
                  aria-describedby={fieldErrors.customerName ? "customerName-error" : undefined}
                  placeholder="Anna Kowalska"
                />
              </Field>

              <Field id="email" label="E-mail" error={fieldErrors.email}>
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={160}
                  className="field-input"
                  value={passenger.email}
                  onChange={(changeEvent) => {
                    setPassenger((current) => ({ ...current, email: changeEvent.target.value }));
                    setFieldErrors((current) => ({ ...current, email: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? "email-error" : undefined}
                  placeholder="anna@example.com"
                />
              </Field>

              {serverError ? <InlineAlert>{serverError}</InlineAlert> : null}

              <button type="submit" className="btn btn-primary min-h-[60px] w-full text-[18px]" disabled={submitting} aria-busy={submitting}>
                {submitting ? (
                  <>
                    <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
                    Rezerwujemy…
                  </>
                ) : (
                  `Rezerwuję na ${ttl}`
                )}
              </button>
              <p className="text-[14px] text-muted">
                Przez {ttl} nikt inny nie zajmie tego miejsca. Potem wraca do sprzedaży, chyba że
                kupisz bilet.
              </p>
            </form>
          </section>
        </div>
      </Frame>
    </div>
  );
}

function Frame({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className={`mx-auto px-4 pb-24 pt-10 sm:px-8 ${narrow ? "max-w-[760px]" : "max-w-[1320px]"}`}>
      {children}
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[15px] font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-2 text-[15px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
