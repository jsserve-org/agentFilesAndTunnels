import { build } from "esbuild";
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
    entryPoints: ["src/panel.ts"],
    outfile: "dist/panel.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    minify: true,
  }),
]);
