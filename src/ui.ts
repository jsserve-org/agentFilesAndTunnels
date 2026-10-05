import { readFile } from "node:fs/promises";
const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);

export function page(origin: string) {
  const escaped = origin.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] || character,
  );
  return html.replaceAll("{{ORIGIN}}", escaped);
}
