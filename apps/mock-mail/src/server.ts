import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

type Mode = "healthy" | "slow" | "down" | "flaky";

interface MailMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  reservationId?: string;
  sentAt: string;
}

interface MailRequest {
  to: string;
  subject: string;
  text: string;
  reservationId?: string;
}

const state = {
  mode: "healthy" as Mode,
  lastModeChangeAt: null as string | null,
  messages: [] as MailMessage[],
  byKey: new Map<string, MailMessage>(),
  pending: new Map<string, Promise<MailMessage>>(),
};

const app = Fastify({ logger: false });
const startedAt = new Date().toISOString();

app.get("/health", async () => ({ ok: true, mode: state.mode }));

app.get("/control", async () => ({
  mode: state.mode,
  sent: state.messages.length,
  lastModeChangeAt: state.lastModeChangeAt,
  startedAt,
  delayMs: state.mode === "slow" ? 3_000 : 0,
}));

app.post("/control", async (request, reply) => {
  const mode = (request.body as { mode?: unknown } | null)?.mode;
  if (mode !== "healthy" && mode !== "slow" && mode !== "down" && mode !== "flaky") {
    return reply.code(400).send({ error: "INVALID_MODE" });
  }

  state.mode = mode;
  state.lastModeChangeAt = new Date().toISOString();
  return {
    mode: state.mode,
    sent: state.messages.length,
    lastModeChangeAt: state.lastModeChangeAt,
    delayMs: state.mode === "slow" ? 3_000 : 0,
  };
});

app.get<{ Querystring: { limit?: string } }>("/messages", async (request) => {
  const limit = Math.max(1, Math.min(100, Number(request.query.limit ?? 25) || 25));
  return state.messages.slice(0, limit);
});

app.post("/reset", async () => {
  state.messages = [];
  state.byKey.clear();
  state.pending.clear();
  state.mode = "healthy";
  state.lastModeChangeAt = new Date().toISOString();
  return { ok: true };
});

app.post("/send", async (request, reply) => {
  const body = request.body as Partial<MailRequest> | null;
  const key = request.headers["idempotency-key"];

  if (
    !body ||
    typeof body.to !== "string" ||
    typeof body.subject !== "string" ||
    typeof body.text !== "string"
  ) {
    return reply.code(400).send({ error: "INVALID_MESSAGE" });
  }
  if (typeof key !== "string" || key.length < 3) {
    return reply.code(400).send({ error: "MISSING_IDEMPOTENCY_KEY" });
  }

  const existing = state.byKey.get(key);
  if (existing) {
    return { id: existing.id, duplicate: true };
  }

  const pending = state.pending.get(key);
  if (pending) {
    const message = await pending;
    return { id: message.id, duplicate: true };
  }

  const work = deliver(body as MailRequest, key);
  state.pending.set(key, work);

  try {
    const message = await work;
    return { id: message.id, duplicate: false };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: "MAIL_PROVIDER_FAILURE" });
  } finally {
    state.pending.delete(key);
  }
});

async function deliver(body: MailRequest, key: string): Promise<MailMessage> {
  switch (state.mode) {
    case "down":
      await sleep(30);
      throw Object.assign(new Error("provider down"), { statusCode: 503 });
    case "slow":
      await sleep(3_000);
      break;
    case "flaky":
      await sleep(25);
      if (Math.random() < 0.5) {
        throw Object.assign(new Error("flaky provider"), { statusCode: 503 });
      }
      break;
    case "healthy":
      await sleep(20 + Math.random() * 30);
      break;
  }

  const message: MailMessage = {
    id: randomUUID(),
    to: body.to,
    subject: body.subject,
    text: body.text,
    idempotencyKey: key,
    ...(body.reservationId ? { reservationId: body.reservationId } : {}),
    sentAt: new Date().toISOString(),
  };

  state.messages.unshift(message);
  state.byKey.set(key, message);
  return message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const port = Number(process.env.MOCK_MAIL_PORT ?? 3002);
const host = process.env.MOCK_MAIL_HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
  console.log(`[mock-mail] nasłuchuję na http://${host}:${port} (tryb: healthy)`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
