import { Readable } from "node:stream";
const { db } = await import("../src/db.ts");
if (db.prepare("SELECT value FROM settings WHERE key='admin_user_id'").get()) {
  throw new Error(
    "An administrator already exists. Use the panel to manage registration.",
  );
}
// Credentials arrive over stdin, never as process arguments or environment variables.
const [email, password] = (
  await new Response(
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ).text()
).split("\n");
if (!email || !password)
  throw new Error("Provide email and password on two stdin lines.");
const { accountAuth } = await import("../src/auth.ts");
const result = await accountAuth.api.createUser({
  body: { email, password, name: email.split("@")[0] },
});
db.transaction(() => {
  const saved = db
    .prepare(
      "INSERT OR IGNORE INTO settings(key,value) VALUES('admin_user_id',?)",
    )
    .run(result.user.id);
  if (saved.changes !== 1)
    throw new Error(
      "Another local bootstrap already created an administrator.",
    );
  db.prepare(
    "UPDATE settings SET value='false' WHERE key='registration_enabled'",
  ).run();
})();
console.log(
  "Administrator created. Log in at " +
    process.env.PUBLIC_ORIGIN +
    ". Public registration stays closed until enabled from the panel.",
);
