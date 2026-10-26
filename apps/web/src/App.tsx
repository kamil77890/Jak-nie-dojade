import { Route, Routes } from "react-router";
import { Shell } from "./components/Shell";
import { EventPage } from "./pages/EventPage";
import { EventsPage } from "./pages/EventsPage";
import { LabPage } from "./pages/LabPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ReservationPage } from "./pages/ReservationPage";
import { ReservePage } from "./pages/ReservePage";
import { TicketPage } from "./pages/TicketPage";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<EventsPage />} />
        <Route path="events/:eventId" element={<EventPage />} />
        <Route path="events/:eventId/reserve/:seatId" element={<ReservePage />} />
        <Route path="reservations/:reservationId" element={<ReservationPage />} />
        <Route path="reservations/:reservationId/ticket" element={<TicketPage />} />
        <Route path="lab" element={<LabPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
