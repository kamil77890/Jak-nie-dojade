import { formatPrice, type ReservationStatusResponse, type Ticket } from "@pas/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { EmptyPanel, ErrorPanel } from "../components/Feedback";
import { Shield } from "../components/Icons";
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
      <div className="page page--narrow">
        <EmptyPanel
          title="Płatność przyjęta"
          message={`Kod biletu: ${status.code}. Szczegóły biletu są w karcie przeglądarki, w której zrobiono rezerwację, i w e-mailu.`}
          action={
            <Link className="button button--primary" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  if (status?.status === "expired") {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="Rezerwacja wygasła przed potwierdzeniem płatności"
          message={`${RESERVATION_EXPIRED_MESSAGE} Jeśli Stripe pobrał ${formatPrice(status.amount)}, zwrócimy całą kwotę automatycznie.`}
          action={
            <Link className="button button--primary" to="/">
              Wybierz miejsce jeszcze raz
            </Link>
          }
        />
      </div>
    );
  }

  const slow = polls >= FAST_POLLS;

  return (
    <div className="page page--narrow">
      <section className="payment-pending" aria-live="polite" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p className="eyebrow">Karta C · powrót ze Stripe'a</p>
        <h1>
          Płatność <em>w toku…</em>
        </h1>
        <p>
          {slow
            ? "Stripe potwierdza płatność dłużej niż zwykle. Nie zamykaj tej strony — bilet pojawi się tu sam."
            : "Czekamy na potwierdzenie od Stripe'a. Za chwilę ta strona sama zamieni się w bilet z kodem."}
        </p>
        {status ? <p className="payment-pending-amount">{formatPrice(status.amount)}</p> : null}
        {error ? (
          <p className="purchase-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="purchase-note">
          <Shield size={16} />
          Bilet wydaje serwer po podpisanym potwierdzeniu od Stripe'a, nie sama strona powrotu.
        </p>
      </section>
    </div>
  );
}
