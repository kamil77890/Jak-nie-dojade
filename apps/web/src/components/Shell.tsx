import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);

  return null;
}

export function Shell() {
  const { pathname } = useLocation();
  const scheduleActive = !pathname.startsWith("/lab");

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        Przejdź do treści
      </a>
      <ScrollToTop />

      <header className="topbar">
        <Link className="brand" to="/" aria-label="PAS — kasa biletowa, strona główna">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>PAS</strong>
            <span>Kasa biletowa · S01</span>
          </span>
        </Link>

        <nav className="main-nav" aria-label="Nawigacja główna">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              isActive || scheduleActive ? "nav-link is-active" : "nav-link"
            }
          >
            Rozkład
          </NavLink>
          <NavLink
            to="/lab"
            className={({ isActive }) => (isActive ? "nav-link is-active" : "nav-link")}
          >
            Laboratorium
          </NavLink>
        </nav>

        <p className="topbar-note">
          <span className="status-dot" aria-hidden="true" />
          Etap I · bez płatności
        </p>
      </header>

      <main id="main" className="main-content">
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer-brand">
          <span className="brand-mark brand-mark--small" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>Projekt PAS · S01</strong>
            <p>Etap I / wariant Pociąg / dane demo</p>
          </div>
        </div>

        <p className="footer-note">
          Trzy karty. Jeden kontrakt. Zero czekania. <br />
          Odporność z E04, przeciążenie z E05, kolejka z E06.
        </p>

        <Link className="footer-lab" to="/lab">
          Zobacz laboratorium niezawodności
          <span aria-hidden="true">↗</span>
        </Link>
      </footer>
    </div>
  );
}
