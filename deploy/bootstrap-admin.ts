import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
if (process.getuid?.() !== 0)
  throw new Error("Run this bootstrap utility as root inside the LXC.");
process.env.DATA_DIR = "/var/lib/relay";
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
process.env.RELAY_BOOTSTRAP_ADMIN = "1";
const { accountAuth } = await import("../src/auth.ts");
try {
  await accountAuth.api.signUpEmail({
    body: { email, password, name: email.split("@")[0] },
  });
  console.log(
    "Administrator created. Log in at " +
      process.env.PUBLIC_ORIGIN +
      ". Registration remains closed; enable it from the panel when ready.",
  );
} finally {
  const ownership = spawnSync("bash", ["/opt/relay/deploy/data-ownership.sh"]);
  if (ownership.status !== 0)
    throw new Error("Could not restore database ownership.");
}
