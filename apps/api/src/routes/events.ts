import type { EventDetailResponse, EventListItem } from "@pas/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BookingService } from "../booking";
import type { EventCatalog } from "../catalog";
import { EventNotFoundError } from "../errors";

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

interface EventRouteDependencies {
  catalog: EventCatalog;
  bookings: BookingService;
  readGuards: Guard[];
}

export function registerEventRoutes(
  app: FastifyInstance,
  dependencies: EventRouteDependencies,
): void {
  app.get("/api/events", { preHandler: dependencies.readGuards }, async (): Promise<EventListItem[]> => {
    return dependencies.catalog.list().map((summary) => {
      const wagons = dependencies.catalog.getEvent(summary.id)?.wagons ?? [];
      const seatCount = wagons.reduce((count, wagon) => count + wagon.seats.length, 0);
      return {
        ...summary,
        wagonCount: wagons.length,
        seatCount,
        freeSeats: seatCount - dependencies.bookings.takenSeats(summary.id).length,
      };
    });
  });

  app.get<{ Params: { id: string } }>(
    "/api/events/:id",
    { preHandler: dependencies.readGuards },
    async (request): Promise<EventDetailResponse> => {
      const event = dependencies.catalog.getEvent(request.params.id);
      if (!event) throw new EventNotFoundError();

      return {
        event,
        takenSeats: dependencies.bookings.takenSeats(event.id),
      };
    },
  );
}
