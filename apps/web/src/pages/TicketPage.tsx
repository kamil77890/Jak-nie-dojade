import { formatDuration, formatEventDate, getSeat, type Ticket } from "@pas/shared";
import { type ReactNode, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { CheckCircle, Printer } from "../components/Icons";
import { splitRelation, timeFromIso, trainLabel, weekdayPl } from "../lib/format";
import { EASE, gsap, scrambleText, useGsap } from "../lib/motion";
import { loadTicket } from "../lib/session";
import { useDocumentTitle } from "../hooks/useCountdown";

export function TicketPage() {
  const { reservationId = "" } = useParams();
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const [ticket] = useState<Ticket | null>(() => {
    const state = location.state as { ticket?: Ticket } | null;
    return state?.ticket ?? loadTicket(reservationId);
  });

  useDocumentTitle(ticket ? `Bilet ${ticket.code}` : "Bilet");

  useGsap(
    root,
    () => {
      const timeline = gsap.timeline({ defaults: { ease: EASE } });
      timeline
        .from(".intro", { y: 30, opacity: 0, duration: 1.1, stagger: 0.08 })
        .from(".ticket-card", { y: 80, rotateX: 28, opacity: 0, duration: 1.6, transformOrigin: "50% 100%" }, "-=0.9")
        .add(() => {
          const code = root.current?.querySelector<HTMLElement>(".ticket-code");
          if (code && ticket) scrambleText(code, ticket.code);
        }, "-=0.8");
    },
    [],
  );

  if (!ticket) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
        <EmptyPanel
          title="Nie widzimy tego biletu"
          message="Bilet zapisujemy tylko w karcie, w której go kupiono. Kod znajdziesz też w e-mailu z potwierdzeniem."
          action={
            <Link className="btn btn-primary" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </div>
    );
  }

  const { event } = ticket;
  const { from, to } = splitRelation(event.relation);
  const [wagonNumber, seatNumber] = ticket.seatId.split("-");
  const position = getSeat(event.id, ticket.seatId)?.position;

  return (
    <div ref={root} className="mx-auto max-w-[860px] px-4 pb-24 pt-12 sm:px-8 [perspective:1400px]">
      <header>
        <p className="intro no-print inline-flex items-center gap-2 rounded-full bg-accent/15 px-3 py-1 text-[14px] font-semibold text-accent-ink">
          <CheckCircle size={16} />
          Zakup potwierdzony
        </p>
        <h1 className="intro mt-5 text-[clamp(48px,7vw,88px)] font-extrabold leading-[0.92] tracking-[-0.02em] condensed">
          Bilet wydany
        </h1>
        <p className="intro mt-4 max-w-[56ch] text-[17px] text-muted">
          Pokaż kod konduktorowi. Potwierdzenie wysyłamy na {ticket.email}, ale bilet jest ważny już
          teraz.
        </p>
      </header>

      <article
        className="ticket-card mt-10 overflow-hidden rounded-[28px] bg-white text-[#0b0d10] shadow-[0_40px_80px_-40px_rgb(0_0_0/0.45)] [--c-ink:#0b0d10] [--c-line:rgb(11_13_16/0.12)] [--c-muted:#5a616c] print:shadow-none print:ring-2 print:ring-black"
        aria-label={`Bilet ${ticket.code}`}
      >
        <header className="flex items-center justify-between bg-[#0b0d10] px-7 py-4 text-white">
          <span className="font-semibold">Bilet jednorazowy</span>
          <span className="rounded-md bg-accent px-2 py-0.5 text-[14px] font-bold text-black condensed">
            {trainLabel(event.id)}
          </span>
        </header>

        <div className="grid gap-6 px-7 pb-7 pt-8 sm:grid-cols-2">
          {[
            ["Odjazd", event.departureTime, from],
            ["Przyjazd", event.arrivalTime, to],
          ].map(([label, time, station]) => (
            <div key={label}>
              <p className="text-[14px] font-semibold text-muted">{label}</p>
              <p className="text-[clamp(56px,8vw,84px)] font-extrabold leading-[0.95] narrow">{time}</p>
              <p className="text-[19px] font-bold">{station}</p>
            </div>
          ))}
        </div>

        <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-3">
          <Cell label="Data">
            {weekdayPl(event.date)}, {formatEventDate(event.date)}
          </Cell>
          <Cell label="Wagon" big>
            {wagonNumber}
          </Cell>
          <Cell label="Miejsce" big>
            {seatNumber}
            {position ? (
              <small className="ml-2 text-[15px] font-semibold [font-stretch:100%]">
                {position === "window" ? "okno" : "korytarz"}
              </small>
            ) : null}
          </Cell>
          <Cell label="Podróżny">{ticket.customerName}</Cell>
          <Cell label="W podróży">{formatDuration(event.departureTime, event.arrivalTime)}</Cell>
          <Cell label="Wydano">{timeFromIso(ticket.issuedAt)}</Cell>
        </dl>

        <div className="ticket-perforation flex flex-wrap items-end justify-between gap-4 px-7 pb-8 pt-7">
          <span className="text-[14px] font-semibold text-muted">Kod biletu</span>
          <strong className="ticket-code text-[clamp(44px,7.4vw,76px)] font-extrabold leading-none tracking-[0.04em] narrow">
            {ticket.code}
          </strong>
        </div>
      </article>

      <div className="intro no-print mt-8 flex flex-wrap gap-3">
        <Link className="btn btn-primary" to="/" viewTransition>
          Wróć do odjazdów
        </Link>
        <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
          <Printer size={17} />
          Drukuj bilet
        </button>
      </div>
    </div>
  );
}

function Cell({ label, children, big = false }: { label: string; children: ReactNode; big?: boolean }) {
  return (
    <div className="border-b border-line px-7 py-4 [&:not(:nth-child(3n+1))]:sm:border-l max-sm:[&:nth-child(2n)]:border-l">
      <dt className="text-[14px] font-semibold text-muted">{label}</dt>
      <dd className={big ? "mt-1 flex items-baseline text-[44px] font-extrabold leading-none narrow" : "mt-1 font-semibold"}>
        {children}
      </dd>
    </div>
  );
}
