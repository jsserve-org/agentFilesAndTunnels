import { db } from "./db.ts";

const origin = new URL(
  process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
);
export function domainSetting(key: string, fallback: string): string {
  return (
    (
      db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value || fallback
  ).toLowerCase();
}
export function tunnelsDomain(): string {
  return domainSetting(
    "tunnels_base_domain",
    process.env.BASE_DOMAIN || origin.hostname,
  );
}
export function sitesDomain(): string {
  return domainSetting(
    "sites_base_domain",
    process.env.SITES_BASE_DOMAIN || process.env.BASE_DOMAIN || origin.hostname,
  );
}
export function filesHost(): string {
  return domainSetting(
    "files_public_host",
    process.env.FILES_PUBLIC_HOST || origin.hostname,
  );
}
export function filesOrigin(): string {
  return filesHost() === origin.hostname
    ? origin.origin
    : `${origin.protocol}//${filesHost()}`;
}
export function validHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) &&
    value
      .split(".")
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 63 &&
          !part.startsWith("-") &&
          !part.endsWith("-"),
      )
  );
}

export type TunnelURLMode = "named" | "random" | "uuid";
export function tunnelURLMode(): TunnelURLMode {
  return domainSetting("tunnel_url_mode", "named") as TunnelURLMode;
}
