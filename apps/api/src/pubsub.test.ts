import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { Redis } from "ioredis";
import { io, type Socket } from "socket.io-client";

// Must be set before socket.js (-> @mimir/backend-core) is imported, since that
// module validates env at load time. Dynamic import keeps evaluation ordered.
process.env.JWT_SECRET = "socket-test-secret";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";

const { initPubSub, initSocket } = await import("./socket.js");
const { signAccessToken } = await import("./tokens.js");

const server = createServer();
initSocket(server);
const subscriber = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
initPubSub(subscriber);
const port = await new Promise<number>((resolve) => {
  server.listen(0, () => resolve((server.address() as { port: number }).port));
});

// Give psubscribe time to register before any publish is attempted.
await Bun.sleep(150);

const pub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });

afterAll(async () => {
  server.close();
  await Promise.all([pub.quit(), subscriber.quit()]);
});

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `access_token=${token}` },
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => reject(e));
  });
}

describe("pub/sub -> socket", () => {
  test("worker publish on user-events:{userId} reaches that user's socket on the payload's event name", async () => {
    const token = await signAccessToken("user-1", "socket-test-secret");
    const socket = await connect(token);
    const received: unknown[] = [];
    socket.on("new_message", (p) => received.push(p));

    await pub.publish("user-events:user-1", JSON.stringify({ event: "new_message", payload: { conversationId: "c-1" } }));
    await Bun.sleep(100);

    expect(received).toEqual([{ conversationId: "c-1" }]);
    socket.disconnect();
  });

  test("events for another user are not delivered", async () => {
    const token = await signAccessToken("user-1", "socket-test-secret");
    const socket = await connect(token);
    let got = 0;
    socket.on("new_message", () => got++);

    await pub.publish("user-events:user-2", JSON.stringify({ event: "new_message", payload: { hi: true } }));
    await Bun.sleep(100);

    expect(got).toBe(0);
    socket.disconnect();
  });
});
