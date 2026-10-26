import {
  DEMO_SEATS_PER_WAGON,
  formatDuration,
  formatEventDateShort,
  type EventSummary,
} from "@pas/shared";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { EmptyPanel, ErrorPanel } from "../components/Feedback";
import { ArrowDown, ArrowRight } from "../components/Icons";
import { getEvent, getEvents } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { freeSeatsWord, splitRelation, trainLabel, weekdayPl } from "../lib/format";
import {
  EASE,
  gsap,
  revealOnScroll,
  scrambleText,
  scrollToTarget,
  ScrollTrigger,
  useGsap,
} from "../lib/motion";
import { formatTtl, ttlParts, useReservationTtl } from "../lib/ttl";
import { useDocumentTitle } from "../hooks/useCountdown";

interface SeatCount {
  free: number;
  total: number;
}

function byDeparture(a: EventSummary, b: EventSummary): number {
  return `${a.date}T${a.departureTime}`.localeCompare(`${b.date}T${b.departureTime}`);
}

/** Liczba słów nie zależy od TTL („15 minut”, „2 minuty”), więc animacja słowo po słowie się nie rozjeżdża. */
function statement(ttl: string): string {
  return `Wybierasz miejsce na planie wagonu. Trzymamy je dla Ciebie przez ${ttl}. Kod biletu dostajesz od razu, bez konta i bez płatności.`;
}

export function EventsPage() {
  useDocumentTitle("Odjazdy");
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [seats, setSeats] = useState<Record<string, SeatCount>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const ttlSeconds = useReservationTtl();
  const ttl = ttlParts(ttlSeconds);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = [...(await getEvents())].sort(byDeparture);
      setEvents(list);

      // Wolne miejsca to dodatek: odjazdy działają także bez nich.
      const details = await Promise.allSettled(list.map((event) => getEvent(event.id)));
      const counts: Record<string, SeatCount> = {};
      details.forEach((result) => {
        if (result.status !== "fulfilled") return;
        const { event, takenSeats } = result.value;
        const total = event.wagons.reduce((sum, wagon) => sum + wagon.seats.length, 0);
        counts[event.id] = { free: total - takenSeats.length, total };
      });
      setSeats(counts);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Choreografia hero i sekcji statycznych — raz, po zamontowaniu.
  useGsap(
    root,
    () => {
      const intro = gsap.timeline({ defaults: { ease: EASE } });
      intro
        .from(".hero-char", { yPercent: 115, duration: 1.5, stagger: 0.022 })
        .from(".hero-fade", { y: 28, opacity: 0, duration: 1.3, stagger: 0.1 }, "-=1.1")
        .from(".hero-card", { y: 60, opacity: 0, duration: 1.5 }, "-=1.2");

      gsap.to(".hero-media", {
        yPercent: 16,
        scale: 1.08,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });
      gsap.to(".hero-content", {
        yPercent: -18,
        opacity: 0,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });

      // Zdanie, które zapala się słowo po słowie, gdy sekcja jest przypięta.
      const words = gsap.utils.toArray<HTMLElement>(".statement-word");
      ScrollTrigger.create({
        trigger: ".statement",
        start: "top top",
        end: "+=120%",
        pin: true,
        scrub: 0.4,
        onUpdate: (self) => {
          const lit = Math.round(self.progress * words.length);
          words.forEach((word, index) => word.classList.toggle("is-lit", index < lit));
        },
      });

      gsap.utils.toArray<HTMLElement>(".chapter").forEach((chapter) => {
        gsap.fromTo(
          chapter.querySelector(".chapter-media"),
          { yPercent: -10 },
          {
            yPercent: 10,
            ease: "none",
            scrollTrigger: { trigger: chapter, start: "top bottom", end: "bottom top", scrub: true },
          },
        );
        gsap.from(chapter.querySelectorAll(".chapter-line"), {
          y: 56,
          opacity: 0,
          duration: 1.3,
          stagger: 0.1,
          ease: EASE,
          scrollTrigger: { trigger: chapter, start: "top 65%" },
        });
      });

      gsap.utils.toArray<HTMLElement>("[data-count]").forEach((element) => {
        const end = Number(element.dataset.count);
        const counter = { value: 0 };
        gsap.to(counter, {
          value: end,
          duration: 1.8,
          ease: "power2.out",
          scrollTrigger: { trigger: element, start: "top 85%", once: true },
          onUpdate: () => {
            element.textContent = String(Math.round(counter.value));
          },
        });
      });

      gsap.utils.toArray<HTMLElement>("[data-scramble]").forEach((element) => {
        const target = element.dataset.scramble ?? "";
        ScrollTrigger.create({
          trigger: element,
          start: "top 85%",
          once: true,
          onEnter: () => scrambleText(element, target, 26),
        });
      });

      revealOnScroll();
    },
    [],
  );

  // Wiersze odjazdów pojawiają się dopiero po załadowaniu danych.
  useGsap(
    root,
    () => {
      if (!events?.length) return;
      gsap.from(".departure-row", {
        y: 40,
        opacity: 0,
        duration: 1.1,
        stagger: 0.09,
        ease: EASE,
        scrollTrigger: { trigger: ".departures", start: "top 75%" },
      });
      gsap.utils.toArray<HTMLElement>(".digit-strip").forEach((strip) => {
        // CSS `translate` trzyma cyfrę docelową; GSAP startuje z zera i wraca do niej.
        gsap.from(strip, {
          yPercent: Number(strip.dataset.digit) * 10,
          duration: 1.6,
          ease: "power4.out",
          scrollTrigger: { trigger: ".departures", start: "top 75%" },
        });
      });
    },
    [events],
  );

  useGsap(
    root,
    () => {
      gsap.utils.toArray<HTMLElement>(".occupancy-fill").forEach((bar) => {
        gsap.from(bar, {
          scaleX: 0,
          duration: 1.4,
          ease: EASE,
          scrollTrigger: { trigger: bar, start: "top 92%" },
        });
      });
    },
    [seats],
  );

  const next = events?.[0];
  const nextSplit = next ? splitRelation(next.relation) : null;
  const totalSeats = events ? events.length * 2 * DEMO_SEATS_PER_WAGON : 0;

  return (
    <div ref={root}>
      {/* ---------- Hero ---------- */}
      <section className="hero relative isolate flex min-h-[100svh] items-end overflow-hidden bg-black text-white">
        <div className="hero-media absolute inset-0 -z-10">
          <video
            className="size-full object-cover"
            src="/media/hero.mp4"
            poster="/media/hero-poster.jpg"
            autoPlay
            muted
            loop
            playsInline
            aria-hidden="true"
          />
        </div>
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/35 to-black/45" />

        <div className="hero-content mx-auto grid w-full max-w-[1320px] items-end gap-10 px-4 pb-14 pt-32 sm:px-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:pb-20">
          <div>
            <h1
              className="max-w-[12ch] text-[clamp(52px,8.4vw,128px)] font-extrabold leading-[0.9] tracking-[-0.02em] condensed"
              aria-label="Bilet na pociąg w minutę."
            >
              <SplitChars text="Bilet na pociąg w minutę." />
            </h1>
            <p className="hero-fade mt-7 max-w-[46ch] text-[clamp(17px,1.5vw,20px)] leading-relaxed text-white/80">
              Wybierz kurs i miejsce na planie wagonu. Trzymamy je dla Ciebie przez {formatTtl(ttlSeconds)}, a kod
              biletu dostajesz od razu po zakupie.
            </p>
            <div className="hero-fade mt-9 flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" onClick={() => scrollToTarget("#odjazdy")}>
                Zobacz odjazdy
                <ArrowDown size={18} />
              </button>
              <button type="button" className="btn btn-glass" onClick={() => scrollToTarget("#jak-to-dziala")}>
                Jak to działa
              </button>
            </div>
          </div>

          <aside className="hero-card rounded-3xl border border-white/15 bg-white/10 p-6 backdrop-blur-xl">
            <p className="text-[14px] font-semibold text-white/70">Najbliższy odjazd</p>
            {next && nextSplit ? (
              <>
                <div className="mt-3 flex items-baseline justify-between gap-4">
                  <span className="text-[64px] font-extrabold leading-none narrow">{next.departureTime}</span>
                  <span className="train-badge !bg-white !text-black">{trainLabel(next.id)}</span>
                </div>
                <p className="mt-3 text-[15px] text-white/70">{nextSplit.from}</p>
                <p className="text-[24px] font-bold leading-tight condensed">
                  {nextSplit.to} <span className="text-white/60">{next.arrivalTime}</span>
                </p>
                <p className="mt-1 text-[14px] text-white/60">
                  {weekdayPl(next.date)}, {formatEventDateShort(next.date)}
                </p>
                <Link to={`/events/${next.id}`} viewTransition className="btn btn-primary mt-6 w-full">
                  Wybierz miejsce
                  <ArrowRight size={18} />
                </Link>
              </>
            ) : (
              <div className="mt-4 space-y-3" aria-busy="true">
                <span className="block h-14 w-40 animate-pulse-soft rounded-xl bg-white/20" />
                <span className="block h-6 w-56 animate-pulse-soft rounded-lg bg-white/15" />
                <span className="block h-12 w-full animate-pulse-soft rounded-full bg-white/15" />
              </div>
            )}
          </aside>
        </div>
      </section>

      {/* ---------- Odjazdy ---------- */}
      <section id="odjazdy" className="departures mx-auto max-w-[1320px] px-4 py-24 sm:px-8 lg:py-32">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h2 data-reveal className="text-[clamp(56px,9vw,132px)] font-extrabold leading-[0.85] tracking-[-0.02em] condensed">
            Odjazdy
          </h2>
          <dl data-reveal className="grid grid-cols-3 gap-8 pb-2 text-right">
            <Stat label="kursy" value={events?.length ?? 3} />
            <Stat label="miejsc" value={totalSeats || 120} />
            <Stat label={`${ttl.unit} na zakup`} value={ttl.value} />
          </dl>
        </div>

        <div className="mt-14 border-t border-line">
          {loading && !events ? (
            <div aria-busy="true" aria-label="Ładowanie odjazdów">
              {[0, 1, 2].map((item) => (
                <div key={item} className="flex items-center gap-8 border-b border-line py-8">
                  <span className="h-16 w-36 animate-pulse-soft rounded-xl bg-raised" />
                  <span className="h-8 flex-1 animate-pulse-soft rounded-lg bg-raised" />
                </div>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="py-10">
              <ErrorPanel title="Odjazdy się nie wczytały" message={error} onRetry={() => void load()} />
            </div>
          ) : null}

          {!error && events && events.length === 0 ? (
            <div className="py-10">
              <EmptyPanel
                title="Brak kursów w sprzedaży"
                message="Żaden pociąg nie jest jeszcze w sprzedaży. Sprawdź ponownie później."
              />
            </div>
          ) : null}

          {!error && events && events.length > 0 ? (
            <ol>
              {events.map((event) => (
                <li key={event.id}>
                  <DepartureRow event={event} count={seats[event.id]} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </section>

      {/* ---------- Zdanie przypięte do scrolla ---------- */}
      <section
        id="jak-to-dziala"
        className="statement relative isolate flex min-h-[100svh] items-center overflow-hidden"
      >
        <img
          src="/media/motion-light.webp"
          alt=""
          className="absolute inset-0 -z-10 size-full object-cover opacity-40 dark:hidden"
        />
        <img
          src="/media/motion-dark.webp"
          alt=""
          className="absolute inset-0 -z-10 hidden size-full object-cover opacity-50 dark:block"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg via-bg/70 to-bg" />
        <p className="mx-auto max-w-[1100px] px-4 text-[clamp(32px,4.6vw,68px)] font-bold leading-[1.08] tracking-[-0.015em] sm:px-8">
          {statement(formatTtl(ttlSeconds)).split(" ").map((word, index) => (
            <span
              key={index}
              className="statement-word text-ink/12 transition-colors duration-500 [&.is-lit]:text-ink"
            >
              {word}{" "}
            </span>
          ))}
        </p>
      </section>

      {/* ---------- Trzy kroki ---------- */}
      <Chapter
        index="01"
        title="Wybierz miejsce"
        text="Plan wagonu pokazuje z góry, które miejsca są wolne, a które przy oknie. Zajęte są wyszarzone, więc nie klikniesz w miejsce, którego nie da się kupić."
        media={<img src="/media/interior.webp" alt="" className="size-full object-cover" />}
        stat={
          <>
            <span data-count="40">40</span>
            <small>miejsc w kursie</small>
          </>
        }
      />
      <Chapter
        index="02"
        title={`Trzymamy je ${formatTtl(ttlSeconds)}`}
        text="Po rezerwacji miejsce znika z planu dla innych. Licznik pokazuje czas serwera, a gdy dobiegnie zera, miejsce wraca do sprzedaży."
        media={
          <video
            className="size-full object-cover"
            src="/media/station.mp4"
            poster="/media/station-poster.jpg"
            autoPlay
            muted
            loop
            playsInline
            aria-hidden="true"
          />
        }
        stat={
          <>
            {/* Bez data-count: licznik GSAP czyta wartość raz, przed odpowiedzią z /api/health. */}
            <span>{ttl.value}</span>
            <small>{ttl.unit} na decyzję</small>
          </>
        }
        reverse
      />
      <Chapter
        index="03"
        title="Kod biletu od razu"
        text="Klikasz „Kupuję bilet” i widzisz kod na ekranie. Potwierdzenie e-mail wysyłamy w tle, więc nawet wolna poczta nie zatrzyma zakupu."
        media={<img src="/media/countryside.webp" alt="" className="size-full object-cover" />}
        stat={
          <>
            <span data-scramble="PAS-7KQ2M9" className="tracking-[0.04em]">
              PAS-7KQ2M9
            </span>
            <small>przykładowy kod</small>
          </>
        }
      />

      {/* ---------- Zaproszenie na koniec ---------- */}
      <section className="relative isolate overflow-hidden bg-black text-white">
        <img src="/media/night-station.webp" alt="" className="absolute inset-0 -z-10 size-full object-cover opacity-55" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/50 to-transparent" />
        <div className="mx-auto max-w-[1320px] px-4 py-28 sm:px-8 lg:py-40">
          <p data-reveal className="text-[15px] font-semibold text-accent">
            {next ? `Najbliższy pociąg odjeżdża o ${next.departureTime}` : "Najbliższe pociągi"}
          </p>
          <h2 data-reveal className="mt-4 max-w-[14ch] text-[clamp(44px,6.4vw,96px)] font-extrabold leading-[0.92] tracking-[-0.02em] condensed">
            Zajmij miejsce, zanim zrobi to ktoś inny.
          </h2>
          <div data-reveal className="mt-10">
            {next ? (
              <Link to={`/events/${next.id}`} viewTransition className="btn btn-primary">
                Wybierz miejsce
                <ArrowRight size={18} />
              </Link>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => scrollToTarget("#odjazdy")}>
                Zobacz odjazdy
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function DepartureRow({ event, count }: { event: EventSummary; count?: SeatCount }) {
  const { from, to } = splitRelation(event.relation);
  const freeShare = count ? count.free / count.total : 0;

  return (
    <Link
      to={`/events/${event.id}`}
      viewTransition
      className="departure-row group grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-4 border-b border-line py-7 transition-colors duration-500 hover:bg-raised/60 sm:-mx-4 sm:px-4 md:grid-cols-[200px_minmax(0,1fr)_200px_auto] md:gap-x-10 lg:rounded-2xl lg:border-transparent lg:hover:border-line"
    >
      <RollingTime value={event.departureTime} />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-muted">
          <span className="train-badge">{trainLabel(event.id)}</span>
          <span>
            {weekdayPl(event.date)}, {formatEventDateShort(event.date)}
          </span>
        </div>
        <p className="mt-2 text-[16px] text-muted">{from}</p>
        <p className="text-[clamp(24px,2.6vw,34px)] font-bold leading-tight condensed">
          {to} <span className="font-semibold text-muted">{event.arrivalTime}</span>
        </p>
        <p className="mt-1 text-[14px] text-muted">
          w podróży {formatDuration(event.departureTime, event.arrivalTime)}
        </p>
      </div>

      <div className="col-span-2 md:col-span-1">
        {count ? (
          <>
            <p className="text-[15px]">
              <strong className="text-[22px] font-extrabold narrow">{count.free}</strong>{" "}
              <span className="text-muted">{freeSeatsWord(count.free)}</span>
            </p>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <span
                className="occupancy-fill block h-full origin-left rounded-full bg-accent"
                style={{ width: `${Math.max(2, freeShare * 100)}%` }}
              />
            </span>
          </>
        ) : (
          <p className="text-[15px] text-muted">2 wagony po {DEMO_SEATS_PER_WAGON} miejsc</p>
        )}
      </div>

      <span className="hidden size-14 place-items-center rounded-full border border-line transition-all duration-500 ease-out-expo group-hover:border-accent group-hover:bg-accent group-hover:text-black md:grid">
        <ArrowRight size={20} className="transition-transform duration-500 ease-out-expo group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

/** Godzina jak na tablicy: każda cyfra przewija się z zera na swoje miejsce. */
function RollingTime({ value }: { value: string }) {
  return (
    <span
      className="flex text-[clamp(56px,6.4vw,88px)] font-extrabold leading-none tracking-[-0.01em] narrow"
      aria-label={value}
    >
      {value.split("").map((char, index) =>
        /\d/.test(char) ? (
          <span key={index} className="inline-block h-[1em] overflow-hidden" aria-hidden="true">
            <span
              className="digit-strip flex flex-col"
              data-digit={char}
              style={{ translate: `0 -${Number(char) * 10}%` }}
            >
              {Array.from({ length: 10 }, (_, digit) => (
                <span key={digit} className="h-[1em]">
                  {digit}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={index} aria-hidden="true">
            {char}
          </span>
        ),
      )}
    </span>
  );
}

function SplitChars({ text }: { text: string }) {
  return (
    <span aria-hidden="true">
      {text.split(" ").map((word, wordIndex) => (
        <span key={wordIndex} className="inline-block overflow-hidden pb-[0.08em] align-bottom">
          {word.split("").map((char, charIndex) => (
            <span key={charIndex} className="hero-char inline-block">
              {char}
            </span>
          ))}
          <span className="inline-block">&nbsp;</span>
        </span>
      ))}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="text-[clamp(32px,3.4vw,48px)] font-extrabold leading-none narrow" data-count={value}>
        {value}
      </dd>
      <dt className="mt-1 text-[14px] text-muted">{label}</dt>
    </div>
  );
}

function Chapter({
  index,
  title,
  text,
  media,
  stat,
  reverse = false,
}: {
  index: string;
  title: string;
  text: string;
  media: ReactNode;
  stat: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="chapter mx-auto grid max-w-[1320px] items-center gap-10 px-4 py-20 sm:px-8 lg:grid-cols-2 lg:gap-20 lg:py-28">
      <div className={`relative aspect-[4/5] overflow-hidden rounded-[28px] sm:aspect-[4/3] lg:aspect-[4/5] ${reverse ? "lg:order-2" : ""}`}>
        <div className="chapter-media absolute inset-[-12%_0]">{media}</div>
      </div>
      <div>
        <p className="chapter-line text-[15px] font-bold text-accent-ink">{index}</p>
        <h3 className="chapter-line mt-3 text-[clamp(40px,5vw,72px)] font-extrabold leading-[0.95] tracking-[-0.02em] condensed">
          {title}
        </h3>
        <p className="chapter-line mt-6 max-w-[44ch] text-[18px] leading-relaxed text-muted">{text}</p>
        <p className="chapter-line mt-10 flex flex-col text-[clamp(48px,5.6vw,80px)] font-extrabold leading-none narrow [&_small]:mt-2 [&_small]:text-[15px] [&_small]:font-semibold [&_small]:text-muted [&_small]:[font-stretch:100%]">
          {stat}
        </p>
      </div>
    </section>
  );
}
