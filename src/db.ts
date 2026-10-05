import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

const dataDir = process.env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });
export const db = new Database(`${dataDir}/app.sqlite`);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
const legacyColumns = db.prepare("PRAGMA table_info(users)").all() as {
  name: string;
}[];
if (legacyColumns.some((column) => column.name === "password")) {
  throw new Error(
    "This database uses the retired custom authentication schema. Back it up and use a new DATA_DIR for Better Auth. Existing credentials are deliberately not accepted. See README.md.",
  );
}
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key_id TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tunnels (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, kind TEXT NOT NULL, local_host TEXT NOT NULL, local_port INTEGER NOT NULL, public_port INTEGER, created_at INTEGER NOT NULL, stopped_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS active_tcp_port ON tunnels(public_port) WHERE stopped_at IS NULL;
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, storage_bytes INTEGER NOT NULL, tunnels INTEGER NOT NULL, agents INTEGER NOT NULL, api_keys INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, visibility TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS site_grants (token_hash TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings(key,value) VALUES('registration_enabled','true');
`);
const tunnelColumns = db.prepare("PRAGMA table_info(tunnels)").all() as {
  name: string;
}[];
if (!tunnelColumns.some((column) => column.name === "public_slug"))
  db.exec("ALTER TABLE tunnels ADD COLUMN public_slug TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS tunnel_public_slug ON tunnels(public_slug) WHERE public_slug IS NOT NULL",
);
export const now = () => Date.now();
export const id = () => crypto.randomUUID().replaceAll("-", "");
export type User = { id: string; email: string };
export type Tunnel = {
  id: string;
  user_id: string;
  agent_id: string;
  kind: "http" | "tcp";
  local_host: string;
  local_port: number;
  public_port: number | null;
  created_at: number;
  stopped_at: number | null;
  public_slug: string | null;
};
export type Agent = {
  id: string;
  user_id: string;
  label: string;
  key_id: string;
};
export type StoredFile = {
  id: string;
  user_id: string;
  name: string;
  size: number;
  content_type: string;
  created_at: number;
  // Zero means keep until deleted; public API serializes this as null.
  expires_at: number;
};
