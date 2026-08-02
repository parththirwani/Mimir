import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { ACCESS_TOKEN_TTL_SECONDS } from "@mimir/backend-core/constants";

// ponytail: nothing hand-rolled here — jose (jwtVerify) rejects alg confusion
// and unknown algos by default. Keep HS256 unless a future phase needs RS256.
export function signAccessToken(userId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}
