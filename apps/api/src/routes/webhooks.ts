import type { FastifyInstance } from "fastify";
import type { CheckoutService } from "../checkout";
import { InvalidSignatureError } from "../errors";

interface WebhookRouteDependencies {
  checkout: CheckoutService;
}

/**
 * Karta B. Podpis Stripe'a liczy się z surowych bajtów, więc w tym kontekście
 * JSON nie jest parsowany — handler dostaje Buffer dokładnie taki, jaki przyszedł.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  dependencies: WebhookRouteDependencies,
): Promise<void> {
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    scope.post("/api/webhooks/stripe", async (request) => {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
        throw new InvalidSignatureError();
      }

      const result = await dependencies.checkout.handleWebhook(request.body, signature);
      if (result.outcome?.kind === "refund") {
        request.log.warn(
          { eventId: result.eventId, reason: result.outcome.reason, refunded: result.refunded },
          "Płatność bez biletu — zwrot",
        );
      }
      return { received: true };
    });
  });
}
