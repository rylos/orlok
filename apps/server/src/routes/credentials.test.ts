import type {
  ApiError,
  Credential,
  Office,
  OpsHost,
  RunnerJobRequest,
  RunnerJobState,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { auditEvents, credentialHosts, credentials } from "../db/schema";
import type { AuditEntry } from "../ops/audit";
import type { RunnerClient } from "../ops/runner-client";
import { createTestDeps, resetDatabase } from "../test/db";
import { createMember, jsonRequest, setupAdmin } from "../test/http";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

async function addHost(name: string, address = "10.0.0.30") {
  const created = await call<OpsHost>("/admin/hosts", "POST", { name, kind: "linux", address });
  expect(created.res.status).toBe(201);
  return created.body;
}

function storeCredential(cookie: string, input: Record<string, unknown>) {
  return call<Credential>(
    "/me/credentials",
    "POST",
    { kind: "password", username: "mario", secret: "S3cret-mario-pass", ...input },
    cookie,
  );
}

describe("personal credentials", () => {
  it("keeps each person's credentials to themselves", async () => {
    const host = await addHost("app03");
    const mine = await storeCredential(adminCookie, { name: "root", hostIds: [host.id] });
    expect(mine.res.status).toBe(201);
    expect(mine.body).not.toHaveProperty("secret");
    const member = await createMember(deps.db, "mario@example.com");

    // Everyone sees the host registry to choose from, but only their own credentials.
    const hosts = await call<OpsHost[]>("/me/hosts", "GET", undefined, member.cookie);
    expect(hosts.body.map((item) => item.name)).toEqual(["app03"]);
    expect(
      (await call<Credential[]>("/me/credentials", "GET", undefined, member.cookie)).body,
    ).toEqual([]);
    const path = `/me/credentials/${mine.body.id}`;
    expect((await call(path, "PATCH", { name: "taken" }, member.cookie)).res.status).toBe(404);
    expect((await call(path, "DELETE", undefined, member.cookie)).res.status).toBe(404);
    expect(
      (await call(`${path}/test`, "POST", { hostId: host.id }, member.cookie)).res.status,
    ).toBe(404);
    // The registry itself is the administrators' to change.
    expect((await call("/admin/hosts", "GET", undefined, member.cookie)).res.status).toBe(403);
  });

  it("checks the hosts and the name of a credential", async () => {
    const host = await addHost("app03");
    const token = await call<ApiError>("/me/credentials", "POST", {
      name: "api",
      kind: "token",
      secret: "t0ken",
      hostIds: [host.id],
    });
    expect(token.res.status).toBe(400);
    expect(token.body.issues).toEqual([{ path: "hostIds", code: "invalid_value" }]);
    const unused = await call<Credential>("/me/credentials", "POST", {
      name: "api",
      kind: "token",
      secret: "t0ken",
    });
    expect(unused.body.hostIds).toEqual([]);

    const unknown = await storeCredential(adminCookie, {
      name: "root",
      hostIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(unknown.res.status).toBe(400);

    const stored = await storeCredential(adminCookie, { name: "root", hostIds: [] });
    const twice = await storeCredential(adminCookie, { name: "root", hostIds: [] });
    expect(twice.res.status).toBe(409);
    expect((twice.body as unknown as ApiError).issues).toEqual([
      { path: "name", code: "name_taken" },
    ]);
    // Testing is only on the hosts it is used on.
    const elsewhere = await call(`/me/credentials/${stored.body.id}/test`, "POST", {
      hostId: host.id,
    });
    expect(elsewhere.res.status).toBe(404);
  });

  it("deletes the credentials of a person who is disabled", async () => {
    const host = await addHost("app03");
    const member = await createMember(deps.db, "mario@example.com");
    await storeCredential(member.cookie, { name: "mario", hostIds: [host.id] });
    await storeCredential(adminCookie, { name: "root", hostIds: [host.id] });

    const disabled = await call(`/admin/people/${member.id}`, "PATCH", { disabled: true });
    expect(disabled.res.status).toBe(200);
    const left = await deps.db.select().from(credentials);
    expect(left.map((row) => row.name)).toEqual(["root"]);
    expect(await deps.db.select().from(credentialHosts)).toHaveLength(1);
    const events = await deps.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "credential.delete"));
    expect(events).toEqual([
      expect.objectContaining({
        officeId: null,
        target: "mario",
        detail: { owner: member.id, reason: "person_disabled" },
      }),
    ]);
  });
});

describe("host registry", () => {
  // Forgetting the host key sends nothing else: it used to reset the port, the tags and the
  // description to their defaults.
  it("changes only what an update names", async () => {
    const created = await call<OpsHost>("/admin/hosts", "POST", {
      name: "nas",
      kind: "linux",
      address: "10.0.0.50",
      port: 2222,
      tags: ["storage"],
      description: "NAS di reparto",
    });
    const reset = await call<OpsHost>(`/admin/hosts/${created.body.id}`, "PATCH", {
      resetHostKey: true,
    });
    expect(reset.body).toMatchObject({
      port: 2222,
      tags: ["storage"],
      description: "NAS di reparto",
      enabled: true,
    });
  });

  it("keeps host names unique in the whole installation, whatever their case", async () => {
    await addHost("app03");
    const twice = await call<ApiError>("/admin/hosts", "POST", {
      name: "APP03",
      kind: "windows",
      address: "10.0.0.31",
    });
    expect(twice.res.status).toBe(409);
    expect(twice.body.issues).toEqual([{ path: "name", code: "name_taken" }]);
  });

  it("leaves the credentials of a deleted host in place, without it", async () => {
    const first = await addHost("app03");
    const second = await addHost("srv10", "10.0.0.31");
    const stored = await storeCredential(adminCookie, {
      name: "root",
      hostIds: [first.id, second.id],
    });
    expect(stored.body.hostIds).toEqual([first.id, second.id]);
    expect((await call(`/admin/hosts/${first.id}`, "DELETE")).res.status).toBe(204);
    const [left] = (await call<Credential[]>("/me/credentials")).body;
    expect(left?.hostIds).toEqual([second.id]);
  });

  it("shows what belongs to no office in the installation log, to administrators only", async () => {
    const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
    const host = await addHost("app03");
    await storeCredential(adminCookie, { name: "root", hostIds: [host.id] });

    const log = await call<AuditEntry[]>("/admin/audit");
    expect(log.body.map((entry) => entry.action).sort()).toEqual([
      "credential.create",
      "host.create",
    ]);
    expect(log.body.find((entry) => entry.action === "credential.create")).toMatchObject({
      target: "root",
      actor: { kind: "person", name: "Administrator" },
    });
    // The office log keeps only what happened in the office.
    const officeLog = await call<AuditEntry[]>(`/offices/${office.id}/ops/audit`);
    expect(officeLog.body).toEqual([]);
    const member = await createMember(deps.db, "mario@example.com", [office.id]);
    expect((await call("/admin/audit", "GET", undefined, member.cookie)).res.status).toBe(403);
  });
});

// Windows hosts reached over WinRM (R-OPS-2): with a password, never with an SSH key.
describe("WinRM hosts", () => {
  const started: RunnerJobRequest[] = [];
  const fakeRunner = {
    async health() {
      return { ok: true, version: "test", tools: [] };
    },
    async start(request: RunnerJobRequest) {
      started.push(request);
    },
    async wait(id: string): Promise<RunnerJobState> {
      return {
        id,
        status: "done",
        exitCode: 0,
        output: "DC01\nexample\\mario",
        truncated: false,
        hostKey: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    },
  } as unknown as RunnerClient;
  const withRunner = createApp({ ...deps, runner: fakeRunner });

  async function callWith<T>(path: string, method = "GET", body?: unknown) {
    const res = await withRunner.request(`/api${path}`, jsonRequest(method, body, adminCookie));
    return { res, body: (res.status === 204 ? null : await res.json()) as T };
  }

  it("is for Windows only", async () => {
    const linux = await call<ApiError>("/admin/hosts", "POST", {
      name: "web01",
      kind: "linux",
      connection: "winrm",
      address: "10.0.0.40",
    });
    expect(linux.res.status).toBe(400);
    const windows = await call<OpsHost>("/admin/hosts", "POST", {
      name: "dc01",
      kind: "windows",
      connection: "winrm",
      address: "10.0.0.10",
      port: 5985,
    });
    expect(windows.body).toMatchObject({ connection: "winrm", port: 5985 });
    const toLinux = await call(`/admin/hosts/${windows.body.id}`, "PATCH", { kind: "linux" });
    expect(toLinux.res.status).toBe(400);
  });

  it("tests a password credential over WinRM and refuses an SSH key", async () => {
    const host = (
      await call<OpsHost>("/admin/hosts", "POST", {
        name: "dc01",
        kind: "windows",
        connection: "winrm_https",
        address: "10.0.0.10",
        port: 5986,
      })
    ).body;
    const password = await storeCredential(adminCookie, {
      name: "dominio",
      username: "EXAMPLE\\mario",
      hostIds: [host.id],
    });
    const tested = await callWith<{ ok: boolean }>(
      `/me/credentials/${password.body.id}/test`,
      "POST",
      { hostId: host.id },
    );
    expect(tested.body.ok).toBe(true);
    expect(started.at(-1)?.target).toEqual({
      kind: "winrm",
      host: "10.0.0.10",
      port: 5986,
      username: "EXAMPLE\\mario",
      password: "S3cret-mario-pass",
      https: true,
    });

    await call(`/me/credentials/${password.body.id}`, "DELETE");
    const key = await storeCredential(adminCookie, {
      name: "key",
      kind: "ssh_key",
      secret: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      hostIds: [host.id],
    });
    const refused = await callWith<{ ok: boolean; error: string }>(
      `/me/credentials/${key.body.id}/test`,
      "POST",
      { hostId: host.id },
    );
    expect(refused.body).toMatchObject({ ok: false, error: "credential_unsupported" });
  });
});
