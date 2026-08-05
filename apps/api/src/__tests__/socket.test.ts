import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { io, type Socket } from "socket.io-client";

// Must be set before socket.js (-> @mimir/backend-core) is imported, since that
// module validates env at load time. Dynamic import keeps evaluation ordered.
process.env.JWT_SECRET = "socket-test-secret";
process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";

const { initSocket, emitToUser } = await import("../infra/socket.js");
const { signAccessToken } = await import("../auth/tokens.js");
const { getConfig } = await import("@mimir/backend-core");
// The middleware verifies with the process-cached config secret (whichever test
// file imported backend-core first). Sign with THAT secret, not a hardcoded one,
// or the handshake is rejected as unauthorized when run in the full suite.
const JWT_SECRET = getConfig().JWT_SECRET;

const server = createServer();
initSocket(server);
const port = await new Promise<number>((resolve) => {
  server.listen(0, () => resolve((server.address() as { port: number }).port));
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

afterAll(() => {
  server.close();
});

describe("socket registry", () => {
  test("rejects an unauthenticated handshake", async () => {
    await expect(connect("bogus-token")).rejects.toThrow();
  });

  test("emit reaches every of a user's sockets, never others, and evicts on disconnect", async () => {
    const tokenA = await signAccessToken("user-1", JWT_SECRET);
    const [a, b] = await Promise.all([connect(tokenA), connect(tokenA)]);
    const other = await connect(await signAccessToken("user-2", JWT_SECRET));

    const counts = { a: 0, b: 0, other: 0 };
    a.on("debug", () => counts.a++);
    b.on("debug", () => counts.b++);
    other.on("debug", () => counts.other++);

    expect(emitToUser("user-1", "debug", { hi: true })).toBe(2);
    await Bun.sleep(50);
    expect(counts).toEqual({ a: 1, b: 1, other: 0 });

    a.disconnect();
    await Bun.sleep(50);
    expect(emitToUser("user-1", "debug", {})).toBe(1);
    await Bun.sleep(50);
    expect(counts).toEqual({ a: 1, b: 2, other: 0 });

    expect(emitToUser("nobody", "debug", {})).toBe(0);
  });
});
