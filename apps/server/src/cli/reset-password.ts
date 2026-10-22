import { parseArgs } from "node:util";
import { type Config, loadConfig } from "../config";
import { createDatabase } from "../db/client";
import type { UserRow } from "../db/schema";
import { createMailer } from "../mail";
import { notifyPasswordChanged, resetPasswordFromServer } from "../services/password-resets";

// orlok-reset-password --email <address>          (inside the app container)
// pnpm --filter @orlok/server reset-password --email <address>      (development)
// The way back in when no administrator can sign in (R-AUTH-7): sets a new random password,
// prints it once, signs the person out everywhere and emails them a notice. Whoever can run it on the server can
// already reach the database, so it works for anyone; a disabled person stays out.

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    database: { type: "string", default: process.env.DATABASE_URL },
  },
});

if (!values.email || !values.database) {
  console.error("Usage: orlok-reset-password --email <address> [--database URL]");
  console.error("DATABASE_URL is read from the environment when --database is not given.");
  process.exit(2);
}

const { db, close } = createDatabase(values.database);

// The security notice to the person, as after any password change. It needs the secret key to
// read the mail settings; without it the reset still stands.
async function notify(user: UserRow) {
  let config: Config;
  try {
    config = loadConfig({ ...process.env, DATABASE_URL: values.database });
  } catch {
    return "No notice emailed: ORLOK_SECRET_KEY is not set here.";
  }
  const status = await notifyPasswordChanged({ db, config, mail: createMailer }, user, "server");
  if (status.sent) {
    return `A notice was emailed to ${user.email}.`;
  }
  return status.reason === "not_configured"
    ? "No notice emailed: email is not configured."
    : `No notice emailed: ${status.message}`;
}
try {
  const outcome = await resetPasswordFromServer(db, values.email);
  if (!outcome.ok) {
    console.error(
      outcome.reason === "not_found"
        ? `Nobody has the email ${values.email}.`
        : `${values.email} is disabled: another administrator must enable them first.`,
    );
    process.exitCode = 1;
  } else {
    const { user, password } = outcome;
    console.log(`Password of ${user.displayName} (${user.email}) reset.`);
    console.log(`New password: ${password}`);
    console.log("All their sessions were signed out.");
    console.log("Change it from Account → Password after signing in.");
    console.log(await notify(user));
  }
} finally {
  await close();
}
