import { betterAuth, type BetterAuthOptions } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { APIError } from "better-auth/api";
import {
  admin,
  bearer,
  deviceAuthorization,
  oneTimeToken,
} from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { db, now } from "./db.ts";

const origin =
  process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32)
  throw new Error(
    "Set BETTER_AUTH_SECRET to a random secret of at least 32 characters.",
  );
const options = {
  appName: "Relay desk",
  baseURL: origin,
  secret,
  database: db,
  trustedOrigins: [origin],
  advanced: {
    ipAddress: { ipAddressHeaders: ["x-relay-client-ip"] },
    cookies: {
      session_token: {
        name:
          new URL(origin).protocol === "https:"
            ? "__Host-relay.session_token"
            : "relay.session_token",
        attributes: {
          path: "/",
          httpOnly: true,
          secure: new URL(origin).protocol === "https:",
          sameSite: "lax",
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 200,
  },
  session: {
    expiresIn: 30 * 86400,
    updateAge: 86400,
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
    },
  },
  plugins: [
    admin(),
    bearer(),
    oneTimeToken({
      storeToken: "hashed",
      disableClientRequest: true,
      disableSetSessionCookie: true,
      expiresIn: 1,
    }),
    deviceAuthorization({
      validateClient: (clientId) => clientId === "relay-cli",
      verificationUri: `${origin}/dashboard/agents`,
    }),
    apiKey({
      enableMetadata: false,
      maximumNameLength: 100,
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (_user, context) => {
          const setting = db
            .prepare(
              "SELECT value FROM settings WHERE key='registration_enabled'",
            )
            .get() as { value: string };
          // The admin plugin handles account creation and password hashing.
          // Its HTTP endpoints are blocked; only our authenticated admin API calls it.
          const adminCreation = context?.path === "/admin/create-user";
          if (setting.value !== "true" && !adminCreation)
            throw new APIError("FORBIDDEN", {
              message: "Registration is closed.",
            });
        },
        after: async (user) => {
          db.prepare(
            "INSERT INTO users(id,email,created_at) VALUES(?,?,?)",
          ).run(user.id, user.email, now());
        },
      },
    },
  },
} satisfies BetterAuthOptions;
const migration = await getMigrations(options);
await migration.runMigrations();
export const accountAuth = betterAuth(options);

export async function issueKey(userId: string, label: string) {
  return accountAuth.api.createApiKey({ body: { userId, name: label } });
}
export async function revokeKey(userId: string, keyId: string) {
  return accountAuth.api.updateApiKey({
    body: { userId, keyId, enabled: false },
  });
}
