import { betterAuth, type BetterAuthOptions } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { APIError } from "better-auth/api";
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
  advanced: { ipAddress: { ipAddressHeaders: ["x-relay-client-ip"] } },
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
    apiKey({
      enableMetadata: false,
      maximumNameLength: 100,
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          const setting = db
            .prepare(
              "SELECT value FROM settings WHERE key='registration_enabled'",
            )
            .get() as { value: string };
          const localBootstrap =
            process.env.RELAY_BOOTSTRAP_ADMIN === "1" &&
            process.getuid?.() === 0 &&
            !db
              .prepare("SELECT value FROM settings WHERE key='admin_user_id'")
              .get();
          if (setting.value !== "true" && !localBootstrap)
            throw new APIError("FORBIDDEN", {
              message: "Registration is closed.",
            });
        },
        after: async (user) => {
          db.prepare(
            "INSERT INTO users(id,email,created_at) VALUES(?,?,?)",
          ).run(user.id, user.email, now());
          db.prepare(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('admin_user_id',?)",
          ).run(user.id);
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
