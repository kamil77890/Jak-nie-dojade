import { formatPrice, type ReservationStatusResponse, type Ticket } from "@pas/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { EmptyPanel, ErrorPanel } from "../components/Feedback";
import { Shield } from "../components/Icons";
import { PurchaseSteps } from "../components/PurchaseSteps";
import { getReservationStatus } from "../lib/api";
import { describeApiError, RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { loadReservation, saveTicket } from "../lib/session";
import { useDocumentTitle } from "../hooks/useCountdown";

/** Webhook zwykle dochodzi w sekundę; potem odpytujemy rzadziej, ale nie przestajemy. */
const FAST_POLL_MS = 1_500;
const SLOW_POLL_MS = 5_000;
const FAST_POLLS = 20;

/**
 * Karta C: success_url Stripe'a. Bilet wydaje webhook, nie ten ekran — dlatego
 * pytamy serwer o status, dopóki rezerwacja nie będzie `paid` albo `expired`.
 */
export function PaymentReturnPage() {
  const { reservationId = "" } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ReservationStatusResponse | null>(null);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle("Płatność w toku");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(attempt: number) {
      try {
        const current = await getReservationStatus(reservationId);
        if (!alive) return;
        setStatus(current);
        setError(null);

        if (current.status === "paid" && current.code) {
          const view = loadReservation(reservationId);
          if (view) {
            const ticket: Ticket = {
              code: current.code,
              reservationId,
              event: view.event,
              seatId: view.seatId,
              customerName: view.customerName,
              email: view.email,
              issuedAt: new Date().toISOString(),
            };
            saveTicket(ticket);
            navigate(`/reservations/${reservationId}/ticket`, { replace: true, state: { ticket } });
          }
          return;
        }
        if (current.status === "expired") return;
      } catch (caught) {
        if (!alive) return;
        setError(describeApiError(caught));
      }

      setPolls(attempt + 1);
      timer = setTimeout(() => void poll(attempt + 1), attempt < FAST_POLLS ? FAST_POLL_MS : SLOW_POLL_MS);
    }

    void poll(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [reservationId, navigate]);

  if (status?.status === "paid" && status.code) {
    // Bilet bez danych rezerwacji (np. inna karta przeglądarki): sam kod też wystarcza przy wejściu.
    return (
      <div className="mx-auto max-w-[760px] px-4 pb-24 pt-10 sm:px-8">
        <PurchaseSteps current={5} />
        <EmptyPanel
          title="Płatność przyjęta"
          message={`Kod biletu: ${status.code}. Szczegóły biletu są w karcie przeglądarki, w której zrobiono rezerwację, i w e-mailu.`}
          action={
            <Link className="btn btn-primary" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </div>
    );
  }

  if (status?.status === "expired") {
    return (
      <div className="mx-auto max-w-[760px] px-4 pb-24 pt-10 sm:px-8">
        <PurchaseSteps current={4} />
        <ErrorPanel
          title="Rezerwacja wygasła przed potwierdzeniem płatności"
          message={`${RESERVATION_EXPIRED_MESSAGE} Jeśli Stripe pobrał ${formatPrice(status.amount)}, zwrócimy całą kwotę automatycznie.`}
          action={
            <Link className="btn btn-primary" to="/" viewTransition>
              Wybierz miejsce jeszcze raz
            </Link>
          }
        />
      </div>
    );
  }

  const slow = polls >= FAST_POLLS;

  return (
    <div className="mx-auto max-w-[760px] px-4 pb-24 pt-10 sm:px-8">
      <PurchaseSteps current={4} />
      <section
        className="card flex flex-col items-center px-6 py-12 text-center sm:px-12 sm:py-16"
        aria-live="polite"
        aria-busy="true"
      >
        <span
          className="size-14 animate-spin rounded-full border-4 border-accent border-r-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="mt-8 text-[15px] font-semibold text-muted">Powrót ze Stripe'a</p>
        <h1 className="mt-2 text-[clamp(44px,6vw,72px)] font-extrabold leading-[0.95] tracking-[-0.02em] condensed">
          Płatność w toku…
        </h1>
        <p className="mt-4 max-w-[48ch] text-[17px] text-muted">
          {slow
            ? "Stripe potwierdza płatność dłużej niż zwykle. Nie zamykaj tej strony — bilet pojawi się tu sam."
            : "Czekamy na potwierdzenie od Stripe'a. Za chwilę ta strona sama zamieni się w bilet z kodem."}
        </p>
        {status ? (
          <p className="mt-6 text-[clamp(36px,4vw,48px)] font-extrabold leading-none narrow">{formatPrice(status.amount)}</p>
        ) : null}
        {error ? (
          <p className="mt-4 font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <p className="mt-8 flex items-start gap-2 border-t border-line pt-6 text-left text-[14px] text-muted">
          <Shield size={16} className="shrink-0" />
          Bilet wydaje serwer po podpisanym potwierdzeniu od Stripe'a, nie sama strona powrotu.
        </p>
      </section>
    </div>
  );
}
