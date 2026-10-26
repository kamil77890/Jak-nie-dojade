import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { scrollToTop, startSmoothScroll } from "../lib/motion";
import { useTheme } from "../lib/theme";
import { Moon, Sun } from "./Icons";

export function Shell() {
  const { pathname } = useLocation();
  const { theme, toggle } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const onHome = pathname === "/";
  // Nad filmem w hero nawigacja jest przezroczysta i biała; potem matowa jak reszta strony.
  const overHero = onHome && !scrolled;

  useEffect(() => {
    startSmoothScroll();
  }, []);

  useEffect(() => {
    scrollToTop();
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled(window.scrollY > 40);
      setProgress(max > 0 ? window.scrollY / max : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `relative rounded-full px-4 py-2 text-[15px] font-semibold transition-colors duration-300 ${
      isActive
        ? overHero
          ? "bg-white/15 text-white"
          : "bg-raised text-ink"
        : overHero
          ? "text-white/75 hover:text-white"
          : "text-muted hover:text-ink"
    }`;

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="absolute -top-20 left-4 z-50 rounded-full bg-accent px-4 py-2 font-semibold text-black focus:top-3"
      >
        Przejdź do treści
      </a>

      <div
        className="no-print fixed inset-x-0 top-0 z-50 h-[3px] origin-left bg-accent"
        style={{ transform: `scaleX(${progress})` }}
        aria-hidden="true"
      />

      <header
        className={`no-print fixed inset-x-0 top-0 z-40 transition-[background-color,border-color,backdrop-filter] duration-500 ease-out-expo ${
          overHero
            ? "border-b border-transparent bg-transparent"
            : "border-b border-line bg-bg/75 backdrop-blur-xl"
        }`}
      >
        <div className="mx-auto flex h-[72px] max-w-[1320px] items-center justify-between gap-4 px-4 sm:px-8">
          <Link
            to="/"
            viewTransition
            className={`flex items-center gap-3 ${overHero ? "text-white" : "text-ink"}`}
            aria-label="PAS, kasa biletowa — strona główna"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-accent text-[22px] font-extrabold leading-none text-black narrow">
              P
            </span>
            <span className="hidden text-[17px] font-semibold sm:inline">Kasa biletowa PAS</span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Nawigacja główna">
            <NavLink
              to="/"
              viewTransition
              className={() => linkClass({ isActive: !pathname.startsWith("/lab") })}
            >
              Odjazdy
            </NavLink>
            <NavLink to="/lab" viewTransition className={linkClass}>
              Laboratorium
            </NavLink>
            <button
              type="button"
              onClick={toggle}
              className={`ml-1 grid size-10 place-items-center rounded-full transition-colors duration-300 ${
                overHero ? "text-white hover:bg-white/15" : "text-ink hover:bg-raised"
              }`}
              aria-label={theme === "dark" ? "Włącz jasny motyw" : "Włącz ciemny motyw"}
              title={theme === "dark" ? "Jasny motyw" : "Ciemny motyw"}
            >
              {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
            </button>
          </nav>
        </div>
      </header>

      <main id="main" className={`flex-1 ${onHome ? "" : "pt-[72px]"}`}>
        <Outlet />
      </main>

      <footer className="no-print border-t border-line">
        <div className="mx-auto grid max-w-[1320px] gap-6 px-4 py-10 text-[14px] text-muted sm:grid-cols-[1fr_auto] sm:px-8">
          <div className="space-y-1.5">
            <p className="font-semibold text-ink">Kasa biletowa PAS</p>
            <p className="max-w-[60ch]">
              Projekt PAS S01, etap I, wariant pociąg. Kursy są przykładowe, płatności dojdą w etapie
              II.
            </p>
            <p>
              Zdjęcia:{" "}
              <a className="underline underline-offset-2 hover:text-ink" href="https://unsplash.com">
                Unsplash
              </a>
              . Filmy:{" "}
              <a className="underline underline-offset-2 hover:text-ink" href="https://www.pexels.com">
                Pexels
              </a>
              .
            </p>
          </div>
          <Link
            to="/lab"
            viewTransition
            className="self-end font-semibold text-ink underline decoration-accent decoration-2 underline-offset-4"
          >
            Jak kasa radzi sobie z awariami
          </Link>
        </div>
      </footer>
    </div>
  );
}
