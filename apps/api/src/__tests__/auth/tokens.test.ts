import { describe, expect, test } from "bun:test";
import { REFRESH_TOKEN_TTL_SECONDS } from "@mimir/backend-core/constants";
import { generateRefreshToken, signAccessToken, verifyAccessToken } from "../../auth/tokens.js";

const SECRET = "test-secret-that-is-long-enough";

describe("access tokens", () => {
  test("roundtrips a userId", async () => {
    const token = await signAccessToken("user-1", SECRET);
    expect(await verifyAccessToken(token, SECRET)).toBe("user-1");
  });

  test("rejects a tampered token", async () => {
    const token = await signAccessToken("user-1", SECRET);
    const [header = "", payload = "", sig = ""] = token.split(".");
    const flipped = payload.slice(0, -1) + (payload.endsWith("a") ? "b" : "a");
    const tampered = `${header}.${flipped}.${sig}`;
    expect(await verifyAccessToken(tampered, SECRET)).toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await signAccessToken("user-1", SECRET);
    expect(await verifyAccessToken(token, "other-secret")).toBeNull();
  });

  test("rejects an expired token", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 5)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyAccessToken(token, SECRET)).toBeNull();
  });
});

describe("refresh tokens", () => {
  test("hash is the sha256 of the token", async () => {
    const { token, hash } = generateRefreshToken();
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hash).toBe(hex);
  });

  test("tokens are unique and 32 random bytes", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
