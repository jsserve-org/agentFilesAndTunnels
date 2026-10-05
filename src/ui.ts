const html = await Bun.file(
  new URL("../public/index.html", import.meta.url),
).text();

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
