import { Link } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { useDocumentTitle } from "../hooks/useCountdown";

export function NotFoundPage() {
  useDocumentTitle("Nie ma takiej strony");

  return (
    <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
      <EmptyPanel
        title="Ten peron nie istnieje"
        message="Adres prowadzi donikąd. Wróć do odjazdów i wybierz kurs."
        action={
          <Link className="btn btn-primary" to="/" viewTransition>
            Wróć do odjazdów
          </Link>
        }
      />
    </div>
  );
}
