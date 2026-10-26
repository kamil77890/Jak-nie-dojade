import { Link } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { useDocumentTitle } from "../hooks/useCountdown";

export function NotFoundPage() {
  useDocumentTitle("Nie ma takiej strony");

  return (
    <div className="page page--narrow">
      <EmptyPanel
        title="Ten peron nie istnieje"
        message="Adres prowadzi donikąd. Wróć do rozkładu i wybierz kurs."
        action={
          <Link className="button button--primary" to="/">
            Wróć do rozkładu
          </Link>
        }
      />
    </div>
  );
}
