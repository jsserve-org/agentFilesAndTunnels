import { Unzip, UnzipInflate } from "fflate";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { join, posix, extname } from "node:path";
import { accountAuth } from "./auth.ts";
import { db, id, now, type User } from "./db.ts";
import { sitesDomain } from "./domains.ts";
import { limitsFor, usageFor } from "./usage.ts";

export type Site = {
  id: string;
  user_id: string;
  name: string;
  visibility: "public" | "login";
  size: number;
  created_at: number;
};
const origin = (
  process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3000}`
).replace(/\/$/, "");
const siteDirectory = join(process.env.DATA_DIR || "./data", "sites");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const siteCookie =
  new URL(origin).protocol === "https:"
    ? "__Host-relay_site_session"
    : "relay_site_session";
export function siteURL(site: Site) {
  return `${new URL(origin).protocol}//s-${site.id}.${sitesDomain()}`;
}
export function showSite(site: Site) {
  return { ...site, url: siteURL(site) };
}
export class SiteError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function unzipSite(bytes: Uint8Array, maximum: number) {
  const files = new Map<string, Uint8Array>();
  let total = 0,
    entries = 0;
  const unzip = new Unzip((file) => {
    if (++entries > 2000)
      throw new SiteError("A site can contain at most 2,000 entries.");
    if (file.name.endsWith("/")) return;
    const path = file.name;
    if (
      path.length > 512 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.startsWith(".") ||
            part === "__relay",
        ) ||
      /[\x00-\x1f:]/.test(path)
    )
      throw new SiteError(
        "ZIP contains an unsafe file path. Use relative paths without hidden files.",
      );
    if (files.has(path))
      throw new SiteError("ZIP contains duplicate file paths.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw new SiteError("Could not read ZIP archive.");
      length += chunk.length;
      total += chunk.length;
      if (total > maximum)
        throw new SiteError(
          "Extracted site exceeds your storage allowance or the 100 MB site limit.",
          413,
        );
      chunks.push(chunk);
      if (final) {
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        files.set(path, data);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small pushes bound decompression allocations before the quota check.
  for (let start = 0; start < bytes.length; start += 4096)
    unzip.push(
      bytes.subarray(start, start + 4096),
      start + 4096 >= bytes.length,
    );
  if (!files.has("index.html"))
    throw new SiteError("Place index.html at the root of the ZIP.");
  return { files, total };
}

export async function createSite(request: Request, user: User) {
  const form = await request.formData();
  const archive = form.get("file"),
    name = form.get("name"),
    visibility = form.get("visibility") || "login";
  if (
    !(archive instanceof File) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 100 ||
    !["public", "login"].includes(String(visibility))
  )
    throw new SiteError(
      "Provide a site name, ZIP file, and public or login visibility.",
    );
  if (archive.size > 100 * 1024 ** 2)
    throw new SiteError("ZIP exceeds the 100 MB upload limit.", 413);
  const available = () =>
    Math.min(
      100 * 1024 ** 2,
      limitsFor(user.id).storage_bytes - usageFor(user.id).storage_bytes,
    );
  if (available() <= 0)
    throw new SiteError("Account storage limit reached.", 413);
  let extracted: ReturnType<typeof unzipSite>;
  try {
    extracted = unzipSite(
      new Uint8Array(await archive.arrayBuffer()),
      available(),
    );
  } catch (error) {
    if (error instanceof SiteError) throw error;
    throw new SiteError("Invalid ZIP archive.");
  }
  // Reserve extracted bytes synchronously so simultaneous uploads cannot overspend.
  if (extracted.total > available())
    throw new SiteError("Account storage limit reached.", 413);
  const site: Site = {
    id: id(),
    user_id: user.id,
    name: name.trim(),
    visibility: visibility as Site["visibility"],
    size: extracted.total,
    created_at: now(),
  };
  db.prepare("INSERT INTO sites VALUES(?,?,?,?,?,?)").run(
    site.id,
    site.user_id,
    site.name,
    site.visibility,
    site.size,
    site.created_at,
  );
  try {
    for (const [path, bytes] of extracted.files) {
      const destination = join(siteDirectory, site.id, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, bytes);
    }
  } catch (error) {
    db.prepare("DELETE FROM sites WHERE id=?").run(site.id);
    await rm(join(siteDirectory, site.id), { recursive: true, force: true });
    throw error;
  }
  return showSite(site);
}

export async function deleteSite(site: Site) {
  await rm(join(siteDirectory, site.id), { recursive: true, force: true });
  db.prepare("DELETE FROM sites WHERE id=?").run(site.id);
}
export async function siteLogin(
  request: Request,
  site: Site,
  returnPath: unknown,
) {
  if (request.headers.has("authorization"))
    throw new SiteError("Log in using your browser session.", 403);
  const token = await accountAuth.api.generateOneTimeToken({
    headers: request.headers,
  });
  db.prepare("INSERT INTO site_grants VALUES(?,?,?)").run(
    hash(token.token),
    site.id,
    now() + 60_000,
  );
  const path =
    typeof returnPath === "string" &&
    returnPath.startsWith("/") &&
    !returnPath.startsWith("//") &&
    !returnPath.includes("\\") &&
    !returnPath.includes("__relay")
      ? returnPath
      : "/";
  const url = new URL("/__relay/callback", siteURL(site));
  url.searchParams.set("token", token.token);
  url.searchParams.set("return_path", path);
  return { url: url.toString() };
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};
export async function serveSite(
  request: Request,
  site: Site,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__relay/callback") {
    const token = url.searchParams.get("token") || "";
    const grant = db
      .prepare(
        "DELETE FROM site_grants WHERE token_hash=? AND site_id=? AND expires_at>? RETURNING site_id",
      )
      .get(hash(token), site.id, now());
    if (!grant)
      return new Response(
        "Login link expired or already used. Open the site again to log in.",
        { status: 401 },
      );
    let session: Awaited<ReturnType<typeof accountAuth.api.verifyOneTimeToken>>;
    try {
      session = await accountAuth.api.verifyOneTimeToken({ body: { token } });
    } catch {
      return new Response("Login expired. Open the site again to log in.", {
        status: 401,
      });
    }
    const returnPath = url.searchParams.get("return_path") || "/";
    const safePath =
      returnPath.startsWith("/") &&
      !returnPath.startsWith("//") &&
      !returnPath.includes("\\") &&
      !returnPath.includes("__relay")
        ? returnPath
        : "/";
    return new Response(null, {
      status: 303,
      headers: {
        location: safePath,
        "set-cookie": `${siteCookie}=${encodeURIComponent(session.session.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor((new Date(session.session.expiresAt).getTime() - now()) / 1000))}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${siteCookie}=`))
    ?.slice(siteCookie.length + 1);
  let session = null;
  if (cookie) {
    try {
      session = await accountAuth.api.getSession({
        headers: new Headers({
          authorization: `Bearer ${decodeURIComponent(cookie)}`,
        }),
      });
    } catch {}
  }
  const loginURL = new URL("/dashboard/sites", origin);
  loginURL.searchParams.set("site_login", site.id);
  loginURL.searchParams.set("return_path", url.pathname + url.search);
  if (url.pathname === "/__relay/me")
    return Response.json(
      {
        user: session
          ? {
              id: session.user.id,
              email: session.user.email,
              name: session.user.name,
            }
          : null,
        login_url: loginURL.toString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  if (url.pathname === "/__relay/logout") {
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== siteURL(site)
    )
      return new Response("POST from the site is required.", { status: 403 });
    return Response.json(
      { ok: true },
      {
        headers: {
          "set-cookie": `${siteCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${new URL(origin).protocol === "https:" ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      },
    );
  }
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Static sites accept GET and HEAD.", { status: 405 });
  if (site.visibility === "login" && !session)
    return Response.redirect(loginURL, 303);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Invalid path.", { status: 400 });
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.startsWith(".") || part === "__relay")
  )
    return new Response("Not found.", { status: 404 });
  path = posix.normalize(path).replace(/^\/+/, "");
  let destination = join(siteDirectory, site.id, path);
  const info = await stat(destination).catch(() => null);
  if (info?.isDirectory()) {
    if (!url.pathname.endsWith("/"))
      return Response.redirect(
        new URL(url.pathname + "/" + url.search, url),
        308,
      );
    destination = join(destination, "index.html");
  }
  const fileInfo = await stat(destination).catch(() => null);
  if (!fileInfo?.isFile())
    return new Response("File not found.", { status: 404 });
  const file = await openAsBlob(destination).catch(() => null);
  if (!file) return new Response("File not found.", { status: 404 });
  return new Response(request.method === "HEAD" ? null : file, {
    headers: {
      "content-type":
        mime[extname(destination).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control":
        site.visibility === "login"
          ? "private, no-store"
          : "public, max-age=60",
      "content-security-policy": "frame-ancestors 'none'",
      "cross-origin-opener-policy": "same-origin",
    },
  });
}
