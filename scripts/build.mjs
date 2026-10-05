import { build } from "esbuild";
import { execFileSync } from "node:child_process";
execFileSync(
  "pnpm",
  [
    "exec",
    "tailwindcss",
    "-i",
    "src/panel.css",
    "-o",
    "dist/panel.css",
    "--minify",
  ],
  { stdio: "inherit" },
);
await Promise.all([
  build({
    entryPoints: ["src/server.ts"],
    outfile: "dist/server.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    sourcemap: true,
  }),
  build({
    entryPoints: ["deploy/bootstrap-admin.ts"],
    outfile: "dist/bootstrap-admin.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
  }),
  build({
    entryPoints: ["src/cli.ts"],
    outfile: "dist/relay.cjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["bufferutil", "utf-8-validate"],
  }),
  build({
    entryPoints: ["src/panel.tsx"],
    outfile: "dist/panel.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
]);
