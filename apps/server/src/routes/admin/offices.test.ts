import type { AdminOffice, ApiError, ModelProfile, Office, WorkspaceOffice } from "@orlok/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { wikiLog, wikiPages, wikiReviewItems, wikiSources } from "../../db/schema";
import { createTestDeps, resetDatabase } from "../../test/db";
import { createColleague, createMember, jsonRequest, setupAdmin } from "../../test/http";

const deps = createTestDeps();
const app = createApp(deps);

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  adminCookie = await setupAdmin(app);
});

function asAdmin(path: string, method = "GET", body?: unknown) {
  return app.request(`/api${path}`, jsonRequest(method, body, adminCookie));
}

async function createOffice(name = "IT Services") {
  const res = await asAdmin("/admin/offices", "POST", { name, description: "IT support" });
  expect(res.status).toBe(201);
  return (await res.json()) as Office;
}

// Every colleague works with a profile (R-MOD-2): the first one, created when there is none.
async function anyProfileId() {
  const [first] = (await (await asAdmin("/admin/profiles")).json()) as ModelProfile[];
  if (first) {
    return first.id;
  }
  const provider = (await (
    await asAdmin("/admin/providers", "POST", { name: "Provider", kind: "anthropic", apiKey: "x" })
  ).json()) as { id: string };
  const profile = await asAdmin("/admin/profiles", "POST", {
    name: "Profile",
    providerId: provider.id,
    model: "model",
    mode: "ask",
  });
  return ((await profile.json()) as ModelProfile).id;
}

// A colleague of the administrator, who is granted the profile it uses.
async function addColleague(officeId: string, body: Record<string, unknown> = {}) {
  const { res, body: colleague } = await createColleague(app, deps.db, adminCookie, {
    officeId,
    name: "Helpdesk",
    title: "First line support",
    instructions: "Be concise.",
    profileId: await anyProfileId(),
    ...body,
  });
  expect(res.status).toBe(201);
  return colleague;
}

describe("offices administration", () => {
  it("is reserved to administrators", async () => {
    const member = await createMember(deps.db, "member@example.com");
    const res = await app.request(
      "/api/admin/offices",
      jsonRequest("GET", undefined, member.cookie),
    );
    expect(res.status).toBe(403);
  });

  it("creates, renames and rejects duplicate offices", async () => {
    const office = await createOffice();
    expect(office).toMatchObject({ name: "IT Services", description: "IT support" });

    const duplicate = await asAdmin("/admin/offices", "POST", { name: "IT Services" });
    expect(duplicate.status).toBe(409);

    const renamed = await asAdmin(`/admin/offices/${office.id}`, "PATCH", {
      name: "IT",
      description: "",
    });
    expect(await renamed.json()).toMatchObject({ name: "IT", description: null });
  });

  it("deletes an office together with its colleagues", async () => {
    const office = await createOffice();
    const colleague = await addColleague(office.id);
    expect((await asAdmin(`/admin/offices/${office.id}`, "DELETE")).status).toBe(204);
    expect((await asAdmin(`/colleagues/${colleague.id}`)).status).toBe(404);
  });

  it("lists offices without anyone's own colleagues", async () => {
    const office = await createOffice();
    await addColleague(office.id);
    const list = (await (await asAdmin("/admin/offices")).json()) as AdminOffice[];
    expect(list).toEqual([
      {
        id: office.id,
        name: "IT Services",
        description: "IT support",
        createdAt: expect.any(String),
        wikiPages: 0,
        // Only the office colleague, set up here by administrators (R-ADM-8).
        colleague: null,
      },
    ]);
  });

  it("empties the wiki of one office, leaving the others alone", async () => {
    const office = await createOffice();
    const other = await createOffice("Accounting");
    for (const [id, title] of [
      [office.id, "VPN"],
      [office.id, "Firewall"],
      [other.id, "Invoices"],
    ] as const) {
      const res = await asAdmin(`/offices/${id}/wiki/pages`, "POST", {
        title,
        type: "entity",
        content: `About ${title}, see [[vpn]].`,
      });
      expect(res.status).toBe(201);
    }
    const source = {
      officeId: office.id,
      fileName: "notes.md",
      format: "markdown",
      sizeBytes: 5,
      sha256: "abc",
      data: Buffer.from("notes"),
      title: "Notes",
      status: "done" as const,
    };
    await deps.db.insert(wikiSources).values(source);
    await deps.db.insert(wikiReviewItems).values({
      officeId: office.id,
      kind: "check",
      key: "check:vpn:1",
      title: "VPN",
      detail: "x",
    });

    const listed = (await (await asAdmin("/admin/offices")).json()) as AdminOffice[];
    expect(listed.map((item) => [item.name, item.wikiPages])).toEqual([
      ["Accounting", 1],
      ["IT Services", 2],
    ]);

    // Not while a document is being read into it.
    await deps.db.update(wikiSources).set({ status: "processing" });
    const busy = await asAdmin(`/admin/offices/${office.id}/wiki`, "DELETE");
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as ApiError).code).toBe("wiki_busy");
    await deps.db.update(wikiSources).set({ status: "done" });

    const cleared = await asAdmin(`/admin/offices/${office.id}/wiki`, "DELETE");
    expect(await cleared.json()).toEqual({ pages: 2, sources: 1 });
    for (const table of [wikiPages, wikiLog, wikiSources, wikiReviewItems]) {
      const rows = await deps.db.select({ officeId: table.officeId }).from(table);
      expect(rows.every((row) => row.officeId === other.id)).toBe(true);
    }
    expect((await asAdmin(`/offices/${other.id}/wiki/pages/invoices`)).status).toBe(200);
    expect(
      (await asAdmin("/admin/offices/00000000-0000-4000-8000-000000000000/wiki", "DELETE")).status,
    ).toBe(404);

    const member = await createMember(deps.db, "member@example.com");
    const refused = await app.request(
      `/api/admin/offices/${other.id}/wiki`,
      jsonRequest("DELETE", undefined, member.cookie),
    );
    expect(refused.status).toBe(403);
  });
});

describe("workspace offices", () => {
  it("shows administrators every office, with their own colleagues", async () => {
    const office = await createOffice();
    await addColleague(office.id);
    const retired = await addColleague(office.id, { name: "Retired" });
    await asAdmin(`/colleagues/${retired.id}`, "PATCH", { archived: true });
    const gone = await addColleague(office.id, { name: "Gone" });
    await asAdmin(`/colleagues/${gone.id}`, "DELETE");

    const res = await asAdmin("/workspace/offices");
    expect((await res.json()) as WorkspaceOffice[]).toEqual([
      {
        id: office.id,
        name: "IT Services",
        description: "IT support",
        colleagues: [
          expect.objectContaining({
            name: "Helpdesk",
            title: "First line support",
            needsProfile: false,
          }),
        ],
        archived: [expect.objectContaining({ name: "Retired" })],
      },
    ]);
  });

  it("shows members only the offices they are assigned to", async () => {
    const office = await createOffice();
    await createOffice("Accounting");

    const outsider = await createMember(deps.db, "outsider@example.com");
    const outsiderOffices = await app.request(
      "/api/workspace/offices",
      jsonRequest("GET", undefined, outsider.cookie),
    );
    expect(await outsiderOffices.json()).toEqual([]);

    const member = await createMember(deps.db, "member@example.com", [office.id]);
    const memberOffices = (await (
      await app.request("/api/workspace/offices", jsonRequest("GET", undefined, member.cookie))
    ).json()) as WorkspaceOffice[];
    expect(memberOffices.map((item) => item.name)).toEqual(["IT Services"]);
  });
});
