import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers";

let ctx: TestContext;
const sockets: Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await ctx?.close();
});

/** Klient, który wysyła nagłówki i początek body, a resztę „zapomina”. */
function slowBody(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "POST /api/reservations HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"e",
      );
      resolve(socket);
    });
    socket.on("error", () => undefined);
    sockets.push(socket);
  });
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}

describe("wolne body nie blokuje kasy", () => {
  it("niedokończone requesty nie zajmują limitu in-flight i są rozłączane po requestTimeout", async () => {
    ctx = await createTestContext({
      overrides: { overload: { maxInFlight: 2, requestTimeoutMs: 400 } },
    });
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = ctx.app.server.address() as AddressInfo;

    const slow = await Promise.all(Array.from({ length: 5 }, () => slowBody(port)));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Pięć wiszących uploadów przy limicie 2 — inny klient i tak dostaje odpowiedź.
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(events.status).toBe(200);
    expect(ctx.services.guards.inFlight).toBe(0);

    // Połączenie, przez które nic nie płynie dłużej niż requestTimeout, jest zamykane.
    await Promise.all(slow.map(closed));
    const normal = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: { eventId: "ic-7310-2026-11-21", seatId: "5-1", customerName: "Anna", email: "a@example.com" },
    });
    expect(normal.statusCode).toBe(201);
  });
});

describe("panel ops", () => {
  it("niecałkowity albo ujemny limit listy jobów nie daje 500", async () => {
    ctx = await createTestContext();
    for (const limit of ["1.5", "-3", "abc", "100000"]) {
      const response = await ctx.app.inject({ method: "GET", url: `/api/ops/jobs?limit=${limit}` });
      expect(response.statusCode).toBe(200);
    }
  });
});
