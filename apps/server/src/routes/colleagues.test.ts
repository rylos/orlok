import type {
  ApiError,
  Colleague,
  ConversationSummary,
  ModelProfile,
  Office,
  WikiRevisionSummary,
  WorkspaceOffice,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { approvedCommandTypes, conversations, opsJobs, wikiPages } from "../db/schema";
import { insertPage } from "../services/wiki";
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

async function setup() {
  const provider = await call<{ id: string }>("/admin/providers", "POST", {
    name: "Provider",
    kind: "anthropic",
    apiKey: "x",
  });
  const profile = (name: string, mode: string) =>
    call<ModelProfile>("/admin/profiles", "POST", {
      name,
      providerId: provider.body.id,
      model: "model",
      mode,
    }).then((created) => created.body);
  const ask = await profile("Sonnet · Ask", "ask");
  const yolo = await profile("Sonnet · Yolo", "yolo");
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
  const elsewhere = (await call<Office>("/admin/offices", "POST", { name: "Accounting" })).body;
  const junior = await createMember(deps.db, "junior@example.com", [office.id]);
  const me = await call<{ id: string }>("/me");
  return { ask, yolo, office, elsewhere, junior, adminId: me.body.id };
}

// What an administrator grants a person: the profiles their colleagues may use (R-MOD-2).
function grant(userId: string, profileIds: string[]) {
  return call(`/admin/people/${userId}`, "PATCH", { profileIds });
}

function create(cookie: string, input: Record<string, unknown>) {
  return call<Colleague>("/colleagues", "POST", input, cookie);
}

describe("personal colleagues", () => {
  it("are created in one's own offices, with a granted profile", async () => {
    const { ask, yolo, office, elsewhere, junior } = await setup();
    await grant(junior.id, [ask.id]);

    const profiles = await call<ModelProfile[]>(
      "/colleagues/profiles",
      "GET",
      undefined,
      junior.cookie,
    );
    expect(profiles.body.map((profile) => profile.name)).toEqual(["Sonnet · Ask"]);

    const outside = await create(junior.cookie, {
      officeId: elsewhere.id,
      name: "Helpdesk",
      profileId: ask.id,
    });
    expect(outside.res.status).toBe(404);
    const notGranted = await create(junior.cookie, {
      officeId: office.id,
      name: "Helpdesk",
      profileId: yolo.id,
    });
    expect(notGranted.res.status).toBe(400);
    expect((notGranted.body as unknown as ApiError).issues).toEqual([
      { path: "profileId", code: "not_granted" },
    ]);

    const created = await create(junior.cookie, {
      officeId: office.id,
      name: "Helpdesk",
      profileId: ask.id,
    });
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Helpdesk",
      profileId: ask.id,
      needsProfile: false,
      archivedAt: null,
    });
    const duplicate = await create(junior.cookie, {
      officeId: office.id,
      name: "HELPDESK",
      profileId: ask.id,
    });
    expect(duplicate.res.status).toBe(409);
    expect((duplicate.body as unknown as ApiError).issues).toEqual([
      { path: "name", code: "name_taken" },
    ]);

    // Administrators too use only the profiles they are granted.
    const unGranted = await create(adminCookie, {
      officeId: office.id,
      name: "Sysadmin",
      profileId: yolo.id,
    });
    expect(unGranted.res.status).toBe(400);
  });

  it("are seen and used by their owner only", async () => {
    const { ask, yolo, office, junior, adminId } = await setup();
    await grant(junior.id, [ask.id]);
    await grant(adminId, [yolo.id]);
    const lucas = (
      await create(adminCookie, { officeId: office.id, name: "Sysadmin", profileId: yolo.id })
    ).body;
    // Names are per person: the junior may have their own "Sysadmin".
    const juniors = await create(junior.cookie, {
      officeId: office.id,
      name: "Sysadmin",
      profileId: ask.id,
    });
    expect(juniors.res.status).toBe(201);

    const workspace = (
      await call<WorkspaceOffice[]>("/workspace/offices", "GET", undefined, junior.cookie)
    ).body;
    expect(workspace[0]?.colleagues.map((item) => item.id)).toEqual([juniors.body.id]);
    const adminWorkspace = (await call<WorkspaceOffice[]>("/workspace/offices")).body;
    const adminOffice = adminWorkspace.find((item) => item.id === office.id);
    expect(adminOffice?.colleagues.map((item) => item.id)).toEqual([lucas.id]);

    const path = `/colleagues/${lucas.id}`;
    expect((await call(path, "GET", undefined, junior.cookie)).res.status).toBe(404);
    expect((await call(path, "PATCH", { name: "Mine" }, junior.cookie)).res.status).toBe(404);
    expect((await call(path, "DELETE", undefined, junior.cookie)).res.status).toBe(404);
    const conversation = await call(
      "/conversations",
      "POST",
      { colleagueId: lucas.id },
      junior.cookie,
    );
    expect(conversation.res.status).toBe(404);
    // Nor can the administrator reach the junior's.
    expect((await call(`/colleagues/${juniors.body.id}`)).res.status).toBe(404);
  });

  it("stop answering when their owner loses the profile", async () => {
    const { ask, yolo, office, junior } = await setup();
    await grant(junior.id, [ask.id, yolo.id]);
    const colleague = (
      await create(junior.cookie, { officeId: office.id, name: "Helpdesk", profileId: yolo.id })
    ).body;
    const conversation = (
      await call<ConversationSummary>(
        "/conversations",
        "POST",
        { colleagueId: colleague.id },
        junior.cookie,
      )
    ).body;

    await grant(junior.id, [ask.id]);
    const workspace = (
      await call<WorkspaceOffice[]>("/workspace/offices", "GET", undefined, junior.cookie)
    ).body;
    expect(workspace[0]?.colleagues[0]).toMatchObject({ id: colleague.id, needsProfile: true });
    const sent = await call<ApiError>(
      `/conversations/${conversation.id}/messages`,
      "POST",
      { content: "Ciao" },
      junior.cookie,
    );
    expect(sent.res.status).toBe(409);
    expect(sent.body.code).toBe("colleague_needs_profile");
    const back = await call<Colleague>(
      `/colleagues/${colleague.id}`,
      "PATCH",
      { profileId: yolo.id },
      junior.cookie,
    );
    expect(back.res.status).toBe(400);

    // Nobody holds the profile any more, so it can go; the colleague waits for another one.
    expect((await call(`/admin/profiles/${yolo.id}`, "DELETE")).res.status).toBe(204);
    const waiting = await call<Colleague>(
      `/colleagues/${colleague.id}`,
      "GET",
      undefined,
      junior.cookie,
    );
    expect(waiting.body).toMatchObject({ profileId: null, needsProfile: true });
    const fixed = await call<Colleague>(
      `/colleagues/${colleague.id}`,
      "PATCH",
      { profileId: ask.id },
      junior.cookie,
    );
    expect(fixed.body).toMatchObject({ profileId: ask.id, needsProfile: false });
  });

  it("are archived with their conversations kept, and restored", async () => {
    const { ask, office, junior } = await setup();
    await grant(junior.id, [ask.id]);
    const colleague = (
      await create(junior.cookie, { officeId: office.id, name: "Helpdesk", profileId: ask.id })
    ).body;
    const conversation = (
      await call<ConversationSummary>(
        "/conversations",
        "POST",
        { colleagueId: colleague.id },
        junior.cookie,
      )
    ).body;

    const archived = await call<Colleague>(
      `/colleagues/${colleague.id}`,
      "PATCH",
      { archived: true },
      junior.cookie,
    );
    expect(archived.body.archivedAt).not.toBeNull();
    const workspace = (
      await call<WorkspaceOffice[]>("/workspace/offices", "GET", undefined, junior.cookie)
    ).body;
    expect(workspace[0]?.colleagues).toEqual([]);
    expect(workspace[0]?.archived.map((item) => item.id)).toEqual([colleague.id]);
    expect(
      (await call(`/conversations/${conversation.id}`, "GET", undefined, junior.cookie)).res.status,
    ).toBe(200);
    expect(
      (await call("/conversations", "POST", { colleagueId: colleague.id }, junior.cookie)).res
        .status,
    ).toBe(404);
    const sent = await call(
      `/conversations/${conversation.id}/messages`,
      "POST",
      { content: "Ciao" },
      junior.cookie,
    );
    expect(sent.res.status).toBe(409);

    const restored = await call<Colleague>(
      `/colleagues/${colleague.id}`,
      "PATCH",
      { archived: false },
      junior.cookie,
    );
    expect(restored.body.archivedAt).toBeNull();
  });

  it("are deleted with everything of theirs but their name in the wiki history", async () => {
    const { ask, office, junior } = await setup();
    await grant(junior.id, [ask.id]);
    const colleague = (
      await create(junior.cookie, { officeId: office.id, name: "Helpdesk", profileId: ask.id })
    ).body;
    await call("/conversations", "POST", { colleagueId: colleague.id }, junior.cookie);
    await insertPage(
      deps.db,
      office.id,
      "vpn",
      { title: "VPN", section: null, type: "procedure", content: "Use WireGuard.", sources: [] },
      { colleagueId: colleague.id },
      "Written from a conversation",
    );
    await deps.db
      .insert(approvedCommandTypes)
      .values({ userId: junior.id, shell: "posix", type: "systemctl restart" });
    const [job] = await deps.db
      .insert(opsJobs)
      .values({
        officeId: office.id,
        colleagueId: colleague.id,
        requestedForUserId: junior.id,
        targetKind: "runner",
        targetName: "runner",
        shell: "posix",
        command: "systemctl restart nginx",
        classification: { decision: "ask", reason: "changes", matchedRules: [], programs: [] },
        status: "pending_approval",
      })
      .returning();

    const deleted = await call(`/colleagues/${colleague.id}`, "DELETE", undefined, junior.cookie);
    expect(deleted.res.status).toBe(204);
    expect(
      (await call(`/colleagues/${colleague.id}`, "GET", undefined, junior.cookie)).res.status,
    ).toBe(404);
    expect(
      await deps.db.select().from(conversations).where(eq(conversations.colleagueId, colleague.id)),
    ).toEqual([]);
    // The types approved "always" are the person's, for all their colleagues: they stay.
    expect(await deps.db.select().from(approvedCommandTypes)).toHaveLength(1);
    const [stopped] = await deps.db
      .select()
      .from(opsJobs)
      .where(eq(opsJobs.id, job?.id ?? ""));
    expect(stopped?.status).toBe("stopped");

    // The wiki still says who wrote what.
    const [page] = await deps.db.select().from(wikiPages);
    const history = await call<WikiRevisionSummary[]>(
      `/offices/${office.id}/wiki/pages/vpn/revisions`,
      "GET",
      undefined,
      junior.cookie,
    );
    expect(page?.updatedByColleagueId).toBe(colleague.id);
    expect(history.body[0]?.author).toEqual({
      kind: "colleague",
      name: "Helpdesk",
      owner: "junior",
      deleted: true,
    });

    // And the name is free again.
    const again = await create(junior.cookie, {
      officeId: office.id,
      name: "Helpdesk",
      profileId: ask.id,
    });
    expect(again.res.status).toBe(201);
  });
});
