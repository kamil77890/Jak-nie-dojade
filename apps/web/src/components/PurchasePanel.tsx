import { formatPrice, type ReservationView } from "@pas/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, startCheckout } from "../lib/api";
import { describeApiError, RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { forgetLoyaltyBalance, loadLoyaltyBalance, peekLoyaltyBalance } from "../lib/loyalty";
import { checkoutKey } from "../lib/session";
import { pointsLabel } from "../lib/format";
import { ArrowRight, Coin, Mail, Shield } from "./Icons";

/** Przejście na stronę Stripe'a. Osobno, żeby testy mogły je podmienić. */
export const redirectTo = {
  assign: (url: string) => window.location.assign(url),
};

const ANNOUNCE_DELAY_MS = 700;

/** Tekst dla czytnika ekranu: kwota do zapłaty i — jeśli są punkty — rozbicie. */
function amountAnnouncement(amount: number, points: number): string {
  const payable = formatPrice(Math.max(0, amount - points));
  if (points <= 0) return `Do zapłaty ${payable}, bez punktów.`;
  return `Do zapłaty ${payable}: cena biletu ${formatPrice(amount)}, punktami ${formatPrice(points)} (${pointsLabel(points)}).`;
}

export function PurchasePanel({
  reservation,
  expired,
  cancelled = false,
  onPaid,
  onExpired,
  onPointsChange,
}: {
  reservation: ReservationView;
  expired: boolean;
  /** Klient wrócił ze Stripe'a przez „Wstecz” / anulowanie. */
  cancelled?: boolean;
  /** Serwer mówi, że rezerwacja jest już opłacona — bilet czeka. */
  onPaid: () => void;
  /** Serwer odrzucił płatność jako wygasłą, choć licznik w przeglądarce jeszcze trwa. */
  onExpired?: () => void;
  /** Wybrane punkty (już przycięte do limitu) — strona pokazuje je w podsumowaniu kursu. */
  onPointsChange?: (points: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [forcedExpired, setForcedExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Karta A/B: saldo pochodzi z Voucherify (przez API). Do połowy ceny można płacić punktami.
  // Saldo pobrane już na ekranie rezerwacji bierzemy z sessionStorage — bez drugiego requestu.
  const [balance, setBalance] = useState<number | null>(() => peekLoyaltyBalance(reservation.email));
  const [pointsRaw, setPointsRaw] = useState("0");
  const [balanceVersion, setBalanceVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    // null (429/503, brak programu) nie blokuje płatności kartą — pole punktów znika.
    void loadLoyaltyBalance(reservation.email).then((points) => {
      if (alive) setBalance(points);
    });
    return () => {
      alive = false;
    };
  }, [reservation.email, balanceVersion]);

  const isExpired = expired || forcedExpired;
  const maxPoints = Math.min(balance ?? 0, Math.floor(reservation.amount / 2));
  const parsedPoints = Number.parseInt(pointsRaw, 10);
  const points = Number.isFinite(parsedPoints) ? Math.max(0, Math.min(parsedPoints, maxPoints)) : 0;
  const payable = Math.max(0, reservation.amount - points);
  const price = formatPrice(payable);

  // Podsumowanie kursu na stronie pokazuje tę samą kwotę „Do zapłaty” co nagłówek i przycisk.
  useEffect(() => {
    onPointsChange?.(points);
  }, [points, onPointsChange]);

  // Jeden region aria-live dla kwoty: ogłaszamy ją dopiero, gdy klient przestanie pisać
  // (pauza 700 ms), a nie przy każdym znaku. Pierwsze wyświetlenie strony nic nie ogłasza.
  const [announcedPoints, setAnnouncedPoints] = useState<number | null>(null);
  const firstPoints = useRef(true);
  useEffect(() => {
    if (firstPoints.current) {
      firstPoints.current = false;
      return;
    }
    const timer = window.setTimeout(() => setAnnouncedPoints(points), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [points]);

  function updatePoints(raw: string) {
    setPointsRaw(raw);
  }

  async function handlePay() {
    if (loading || isExpired) return;
    setLoading(true);
    setError(null);

    try {
      const { url } = await startCheckout(
        reservation.reservationId,
        checkoutKey(reservation.reservationId),
        points,
      );
      // Punkty zeszły z karty — zapamiętane saldo jest już nieaktualne.
      if (points > 0) forgetLoyaltyBalance(reservation.email);
      redirectTo.assign(url);
      // Przycisk zostaje w stanie „Przechodzimy…”, dopóki przeglądarka nie zmieni strony.
    } catch (caught) {
      setLoading(false);
      if (caught instanceof ApiRequestError && caught.code === "RESERVATION_PAID") {
        onPaid();
        return;
      }
      if (caught instanceof ApiRequestError && caught.code === "RESERVATION_EXPIRED") {
        setForcedExpired(true);
        onExpired?.();
      }
      if (caught instanceof ApiRequestError && caught.code === "INSUFFICIENT_POINTS") {
        // Saldo zmieniło się poza tą kartą — pobierz je jeszcze raz.
        forgetLoyaltyBalance(reservation.email);
        setBalanceVersion((version) => version + 1);
      }
      setError(describeApiError(caught));
    }
  }

  if (isExpired) {
    return (
      <section>
        <div className="rounded-2xl border border-danger/30 bg-danger/8 p-6" role="alert">
          <h2 className="text-[24px] font-extrabold leading-tight text-danger condensed">
            {RESERVATION_EXPIRED_MESSAGE}
          </h2>
          <p className="mb-5 mt-2 text-muted">
            Po czasie nie przyjmujemy płatności. Wybierz miejsce jeszcze raz — inne albo to samo, jeśli
            wciąż jest wolne.
          </p>
          <Link className="btn btn-dark w-full" to={`/events/${reservation.event.id}`} viewTransition>
            Wróć do planu wagonu
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="purchase-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[clamp(22px,2.2vw,28px)] font-bold leading-tight condensed">
          {cancelled ? "Płatność przerwana." : "Do zapłaty"}
        </h2>
        <p className="purchase-panel-price text-[clamp(36px,4vw,48px)] font-extrabold leading-none narrow">{price}</p>
      </div>
      <p className="mb-5 mt-2 text-[15px] text-muted">
        {cancelled
          ? "Nic nie pobraliśmy. Miejsce wciąż jest Twoje — możesz zapłacić jeszcze raz, dopóki licznik biegnie."
          : "Klikniesz „Zapłać”, przejdziesz na stronę płatności Stripe'a, a po zapłacie wrócisz po bilet z kodem."}
      </p>

      {balance !== null && maxPoints > 0 ? (
        <div className="points-panel">
          <div className="flex items-center gap-3">
            <span className="points-badge" aria-hidden="true">
              <Coin size={18} />
            </span>
            <label htmlFor="points" className="text-[17px] font-bold leading-tight">
              Użyj punktów
            </label>
            <span id="points-balance" className="ml-auto text-right text-[14px] text-muted">
              masz <strong className="font-semibold text-ink">{balance.toLocaleString("pl-PL")} pkt</strong>
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-stretch gap-2">
            <div className="relative min-w-[132px] flex-1">
              <input
                id="points"
                name="points"
                type="number"
                inputMode="numeric"
                min={0}
                max={maxPoints}
                step={1}
                className="field-input pr-14 text-[20px] font-bold"
                value={pointsRaw}
                onChange={(changeEvent) => updatePoints(changeEvent.target.value)}
                onBlur={() => setPointsRaw(String(points))}
                aria-describedby="points-balance points-hint"
              />
              <span
                className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-[15px] font-semibold text-muted"
                aria-hidden="true"
              >
                pkt
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost min-h-14 shrink-0 whitespace-nowrap px-5 max-sm:grow"
              onClick={() => setPointsRaw(String(maxPoints))}
            >
              Użyj maksimum
            </button>
          </div>
          <p id="points-hint" className="mt-3 text-[14px] text-muted">
            Możesz użyć do{" "}
            <strong className="font-semibold text-ink">
              {pointsLabel(maxPoints)} ({formatPrice(maxPoints)})
            </strong>{" "}
            — punktami zapłacisz najwyżej połowę ceny biletu. 100 punktów = 1 zł.
          </p>
          {/* Wyliczenie zmienia się przy wpisywaniu; czytnik dostaje je z jednego regionu niżej. */}
          <div className="empty:hidden">
            {points > 0 ? (
              <dl className="points-receipt" aria-label="Wyliczenie płatności">
                <div>
                  <dt>Cena biletu</dt>
                  <dd>{formatPrice(reservation.amount)}</dd>
                </div>
                <div>
                  <dt>Punktami</dt>
                  <dd>− {formatPrice(points)}</dd>
                </div>
                <div className="points-receipt-total">
                  <dt>Kartą</dt>
                  <dd>{formatPrice(payable)}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcedPoints === null ? "" : amountAnnouncement(reservation.amount, announcedPoints)}
      </p>

      <button
        type="button"
        className="btn btn-primary group min-h-[64px] w-full text-[19px]"
        onClick={() => void handlePay()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
            Przechodzimy do płatności…
          </>
        ) : (
          <>
            {cancelled ? `Zapłać ponownie ${price}` : `Zapłać ${price}`}
            <ArrowRight size={20} className="transition-transform duration-300 group-hover:translate-x-1" />
          </>
        )}
      </button>

      {error ? (
        <p className="mt-3 font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 space-y-2 text-[14px] text-muted">
        <li className="flex gap-2">
          <Shield size={16} className="mt-0.5 shrink-0" />
          <span>
            Tryb testowy Stripe: karta 4242 4242 4242 4242, dowolna przyszła data i CVC. Prawdziwe
            pieniądze nie są pobierane.
          </span>
        </li>
        <li className="flex gap-2">
          <Mail size={16} className="mt-0.5 shrink-0" />
          <span>Po płatności potwierdzenie e-mail wyślemy w tle. Bilet zobaczysz od razu.</span>
        </li>
      </ul>
    </section>
  );
}
