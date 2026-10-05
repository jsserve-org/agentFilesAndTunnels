import { db } from "./db.ts";

export type Limits = {
  storage_bytes: number;
  tunnels: number;
};
export const defaultLimits: Limits = {
  storage_bytes: Number(
    process.env.MAX_USER_STORAGE_BYTES || 1024 * 1024 * 1024,
  ),
  tunnels: 100,
};
export function limitsFor(userId: string): Limits {
  return (
    (db
      .prepare("SELECT storage_bytes,tunnels FROM user_limits WHERE user_id=?")
      .get(userId) as Limits | undefined) ?? defaultLimits
  );
}
export function usageFor(
  userId: string,
): Limits & { agents: number; api_keys: number } {
  const count = (table: string, filter = "") =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=? ${filter}`,
        )
        .get(userId) as { count: number }
    ).count;
  return {
    storage_bytes: (
      db
        .prepare(
          "SELECT (SELECT COALESCE(SUM(size),0) FROM files WHERE user_id=@user) + (SELECT COALESCE(SUM(size),0) FROM sites WHERE user_id=@user) AS bytes",
        )
        .get({ user: userId }) as { bytes: number }
    ).bytes,
    tunnels: count("tunnels", "AND stopped_at IS NULL"),
    agents: count("agents"),
    api_keys: count("account_keys"),
  };
}
export function parseLimits(value: unknown): Limits | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(defaultLimits)) {
    if (
      typeof input[key] !== "number" ||
      !Number.isSafeInteger(input[key]) ||
      input[key] < 0
    )
      return null;
  }
  return {
    storage_bytes: input.storage_bytes as number,
    tunnels: input.tunnels as number,
  };
}
export function saveLimits(userId: string, limits: Limits) {
  db.prepare(
    "INSERT INTO user_limits VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET storage_bytes=excluded.storage_bytes,tunnels=excluded.tunnels",
  ).run(userId, limits.storage_bytes, limits.tunnels, 0, 0);
}
