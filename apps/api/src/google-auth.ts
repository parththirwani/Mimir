import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";

const cfg = getConfig();
const prisma = getPrismaClient();

function oauthError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// Only register when creds exist; the routes 503 before this is ever exercised otherwise.
if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REDIRECT_URI) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: cfg.GOOGLE_CLIENT_ID,
        clientSecret: cfg.GOOGLE_CLIENT_SECRET,
        callbackURL: cfg.GOOGLE_REDIRECT_URI,
      },
      async (_accessToken, _refreshToken, profile: Profile, done) => {
        try {
          const googleId = profile.id;
          let user = await prisma.user.findUnique({ where: { googleId } });
          if (!user) {
            const email = profile.emails?.[0]?.value;
            if (!email) return done(oauthError("OAUTH_ERROR", "Google account has no email"));
            if (await prisma.user.findUnique({ where: { email } })) {
              return done(
                oauthError("EMAIL_TAKEN", "An account with this email already exists; log in with your password"),
              );
            }
            user = await prisma.user.create({ data: { email, googleId } });
          }
          return done(null, user);
        } catch (e) {
          getLogger().error({ err: e }, "google strategy error");
          return done(e instanceof Error ? e : new Error(String(e)));
        }
      },
    ),
  );
}
