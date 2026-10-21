import { randomUUID } from "node:crypto";
import {
  credentialCreateSchema,
  credentialTestSchema,
  credentialUpdateSchema,
} from "@orlok/shared/schemas";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { currentUser, requireUser } from "../auth/middleware";
import { hosts } from "../db/schema";
import { errorBody, uniqueViolation } from "../lib/errors";
import { idParamSchema, validate } from "../lib/validation";
import { audit } from "../ops/audit";
import { findHost, listHosts, runnerTargetFor, toHost } from "../ops/hosts";
import {
  createCredential,
  credentialIdForHost,
  deleteCredential,
  findCredential,
  hostsProblem,
  listCredentials,
  revealCredential,
  updateCredential,
} from "../ops/vault";
import type { AppEnv, Deps } from "../types";

const credentialNotFound = errorBody("not_found", "Credential not found");
const nameTaken = errorBody("conflict", "You already have a credential with this name", [
  { path: "name", code: "name_taken" },
]);
const tokenHosts = errorBody("validation_failed", "A token is not used on hosts", [
  { path: "hostIds", code: "invalid_value" },
]);

function hostsError(problem: "invalid_value" | "host_has_credential") {
  return problem === "invalid_value"
    ? errorBody("validation_failed", "Unknown host", [{ path: "hostIds", code: problem }])
    : errorBody("conflict", "Another of your credentials is already used on one of these hosts", [
        { path: "hostIds", code: problem },
      ]);
}

function conflictBody(error: unknown) {
  const index = uniqueViolation(error);
  if (index === null) {
    return null;
  }
  return index === "credential_hosts_user_host_idx" ? hostsError("host_has_credential") : nameTaken;
}

// A person's own credentials, and the host registry they choose hosts from (R-OPS-1, R-OPS-3).
// Every route works on the signed-in person's credentials only: nobody else's are ever listed,
// changed or tried, administrators included.
export function credentialRoutes({ db, config, runner }: Deps) {
  return (
    new Hono<AppEnv>()
      .use(requireUser)
      .get("/hosts", async (c) => c.json((await listHosts(db)).map(toHost)))
      .get("/credentials", async (c) => c.json(await listCredentials(db, currentUser(c).id)))
      .post("/credentials", validate("json", credentialCreateSchema), async (c) => {
        const user = currentUser(c);
        const input = c.req.valid("json");
        if (input.kind === "token" && input.hostIds.length > 0) {
          return c.json(tokenHosts, 400);
        }
        const problem = await hostsProblem(db, user.id, input.hostIds, null);
        if (problem) {
          return c.json(hostsError(problem), problem === "invalid_value" ? 400 : 409);
        }
        try {
          return c.json(await createCredential(db, user.id, input, config.secretKey), 201);
        } catch (error) {
          const conflict = conflictBody(error);
          if (conflict) {
            return c.json(conflict, 409);
          }
          throw error;
        }
      })
      .patch(
        "/credentials/:id",
        validate("param", idParamSchema),
        validate("json", credentialUpdateSchema),
        async (c) => {
          const user = currentUser(c);
          const input = c.req.valid("json");
          const current = await findCredential(db, user.id, c.req.valid("param").id);
          if (!current) {
            return c.json(credentialNotFound, 404);
          }
          if (input.hostIds) {
            if (current.kind === "token" && input.hostIds.length > 0) {
              return c.json(tokenHosts, 400);
            }
            const problem = await hostsProblem(db, user.id, input.hostIds, current.id);
            if (problem) {
              return c.json(hostsError(problem), problem === "invalid_value" ? 400 : 409);
            }
          }
          try {
            const updated = await updateCredential(db, current, input, config.secretKey);
            return updated ? c.json(updated) : c.json(credentialNotFound, 404);
          } catch (error) {
            const conflict = conflictBody(error);
            if (conflict) {
              return c.json(conflict, 409);
            }
            throw error;
          }
        },
      )
      .delete("/credentials/:id", validate("param", idParamSchema), async (c) => {
        const current = await findCredential(db, currentUser(c).id, c.req.valid("param").id);
        if (!current) {
          return c.json(credentialNotFound, 404);
        }
        await deleteCredential(db, current);
        return c.body(null, 204);
      })
      // Connects to one of the credential's hosts and runs a harmless command, as a colleague
      // would. The host key belongs to the machine: the first connection that gets in fixes it
      // for everyone, and later ones must match it.
      .post(
        "/credentials/:id/test",
        validate("param", idParamSchema),
        validate("json", credentialTestSchema),
        async (c) => {
          const user = currentUser(c);
          const chosen = await findCredential(db, user.id, c.req.valid("param").id);
          if (!chosen) {
            return c.json(credentialNotFound, 404);
          }
          // Only on its own hosts: the ones colleagues would use it on.
          const { hostId } = c.req.valid("json");
          const host =
            (await credentialIdForHost(db, user.id, hostId)) === chosen.id
              ? await findHost(db, hostId)
              : null;
          if (!host) {
            return c.json(errorBody("not_found", "Host not found"), 404);
          }
          if (!runner) {
            return c.json({ ok: false, error: "runner_not_configured", output: "" });
          }
          const credential = await revealCredential(db, chosen.id, config.secretKey);
          if (!credential?.username || credential.kind === "token") {
            return c.json({ ok: false, error: "credential_missing", output: "" });
          }
          const jobId = randomUUID();
          const shell = host.kind === "windows" ? "powershell" : "posix";
          const target = runnerTargetFor(
            host,
            { ...credential, username: credential.username },
            shell,
          );
          if ("error" in target) {
            return c.json({ ok: false, error: target.error, output: "" });
          }
          try {
            await runner.start({
              id: jobId,
              target,
              // whoami answers the question a test is really asked: which account did we get in
              // as, the limited one or the powerful one?
              command:
                shell === "powershell"
                  ? "hostname; whoami; $PSVersionTable.PSVersion.ToString()"
                  : "hostname; whoami; uname -sr",
              timeoutSeconds: 20,
              maxOutputBytes: 4_000,
              secrets: [
                credential.secret,
                ...(credential.passphrase ? [credential.passphrase] : []),
              ],
            });
            const state = await runner.wait(jobId, { timeoutMs: 30_000 });
            const ok = state.status === "done" && state.exitCode === 0;
            if (ok && !host.hostKey && state.hostKey) {
              await db.update(hosts).set({ hostKey: state.hostKey }).where(eq(hosts.id, host.id));
            }
            await audit(db, {
              officeId: null,
              actor: { userId: user.id },
              action: "host.test",
              target: host.name,
              detail: { ok, error: state.error, credential: chosen.name },
            });
            return c.json({ ok, error: state.error, output: state.output, hostKey: state.hostKey });
          } catch (error) {
            return c.json({
              ok: false,
              error: error instanceof Error ? error.message : "runner_error",
              output: "",
            });
          }
        },
      )
  );
}
