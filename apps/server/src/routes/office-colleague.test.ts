import type {
  AdminOffice,
  ApiError,
  Colleague,
  Conversation,
  ConversationSummary,
  ModelProfile,
  ModelProvider,
  Office,
  WorkspaceOffice,
} from "@orlok/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { conversations, messages } from "../db/schema";
import type { ChatRequest, LlmClientFactory } from "../llm";
import { createTestDeps, resetDatabase } from "../test/db";
import { createMember, jsonRequest, parseSse, setupAdmin } from "../test/http";

// The office colleague (R-ADM-8): one per office, set up by an administrator with any profile,
// there for everyone in the office, each in a private conversation, and only reading the wiki.

const deps = createTestDeps();
const requests: ChatRequest[] = [];
const fakeLlm: LlmClientFactory = () => ({
  async listModels() {
    return [];
  },
  async *streamChat(request) {
    requests.push(request);
    yield { type: "text", text: "Non è in wiki." };
    yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } };
  },
});
const app = createApp({ ...deps, llm: fakeLlm });

afterAll(() => deps.close());

let adminCookie: string;

beforeEach(async () => {
  await resetDatabase(deps.db);
  requests.length = 0;
  adminCookie = await setupAdmin(app);
});

async function call<T>(path: string, method = "GET", body?: unknown, cookie = adminCookie) {
  const res = await app.request(`/api${path}`, jsonRequest(method, body, cookie));
  return { res, body: (res.status === 204 ? null : await res.json()) as T };
}

// A profile granted to nobody, the administrator included, and an office with two members.
async function setup() {
  const provider = await call<ModelProvider>("/admin/providers", "POST", {
    name: "Provider",
    kind: "anthropic",
    apiKey: "x",
  });
  const profile = (
    await call<ModelProfile>("/admin/profiles", "POST", {
      name: "Haiku · Full access",
      providerId: provider.body.id,
      model: "model",
      mode: "full",
    })
  ).body;
  const office = (await call<Office>("/admin/offices", "POST", { name: "IT" })).body;
  const elsewhere = (await call<Office>("/admin/offices", "POST", { name: "Accounting" })).body;
  const anna = await createMember(deps.db, "anna@example.com", [office.id]);
  const bruno = await createMember(deps.db, "bruno@example.com", [office.id]);
  const carla = await createMember(deps.db, "carla@example.com", [elsewhere.id]);
  return { profile, office, elsewhere, anna, bruno, carla };
}

function createOfficeColleague(officeId: string, profileId: string, cookie = adminCookie) {
  return call<Colleague>(
    `/admin/offices/${officeId}/colleague`,
    "POST",
    { name: "Guida", title: "Risponde sulla wiki", instructions: "Sii gentile.", profileId },
    cookie,
  );
}

async function workspace(cookie: string) {
  return (await call<WorkspaceOffice[]>("/workspace/offices", "GET", undefined, cookie)).body;
}

async function ask(conversationId: string, content: string, cookie: string) {
  const res = await app.request(
    `/api/conversations/${conversationId}/messages`,
    jsonRequest("POST", { content }, cookie),
  );
  return { res, events: res.ok ? parseSse(await res.text()) : [] };
}

describe("office colleague", () => {
  it("is set up by an administrator with any profile, once per office", async () => {
    const { profile, office, anna } = await setup();
    const created = await createOfficeColleague(office.id, profile.id);
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Guida", officeWide: true, needsProfile: false });

    expect((await createOfficeColleague(office.id, profile.id)).res.status).toBe(409);
    expect((await createOfficeColleague(office.id, profile.id, anna.cookie)).res.status).toBe(403);
    const unknown = await createOfficeColleague(office.id, "00000000-0000-4000-8000-000000000000");
    expect(unknown.res.status).toBe(400);

    const offices = (await call<AdminOffice[]>("/admin/offices")).body;
    expect(offices.find((item) => item.id === office.id)?.colleague?.name).toBe("Guida");
    expect(offices.find((item) => item.id !== office.id)?.colleague).toBeNull();
  });

  it("is everyone's in the office, changed only by administrators", async () => {
    const { profile, office, anna, carla } = await setup();
    const { id } = (await createOfficeColleague(office.id, profile.id)).body;

    const listed = (await workspace(anna.cookie))[0]?.colleagues;
    expect(listed).toEqual([
      expect.objectContaining({ id, officeWide: true, needsProfile: false }),
    ]);
    expect((await workspace(carla.cookie))[0]?.colleagues).toEqual([]);

    // The person sees who it is, not what the administrator told it.
    const seen = await call<Colleague>(`/colleagues/${id}`, "GET", undefined, anna.cookie);
    expect(seen.body).toMatchObject({ name: "Guida", instructions: "", officeWide: true });
    expect((await call(`/colleagues/${id}`, "GET", undefined, carla.cookie)).res.status).toBe(404);
    const renamed = await call(`/colleagues/${id}`, "PATCH", { name: "Mia" }, anna.cookie);
    expect(renamed.res.status).toBe(404);
    expect((await call(`/colleagues/${id}`, "DELETE", undefined, anna.cookie)).res.status).toBe(
      404,
    );
    // Nor through the personal routes for the administrator who created it.
    expect((await call(`/colleagues/${id}`, "PATCH", { name: "Mia" })).res.status).toBe(404);

    const changed = await call<Colleague>(`/admin/offices/${office.id}/colleague`, "PATCH", {
      name: "Info",
    });
    expect(changed.body.name).toBe("Info");
    // Its name does not take one from the administrator's own colleagues.
    const [granted] = (await call<ModelProfile[]>("/admin/profiles")).body;
    await call(`/admin/people/${(await call<{ id: string }>("/me")).body.id}`, "PATCH", {
      profileIds: [granted?.id],
    });
    const own = await call("/colleagues", "POST", {
      officeId: office.id,
      name: "Info",
      profileId: granted?.id,
    });
    expect(own.res.status).toBe(201);
  });

  it("keeps each person's conversations private and only reads the wiki", async () => {
    const { profile, office, anna, bruno } = await setup();
    const { id } = (await createOfficeColleague(office.id, profile.id)).body;

    const started = await call<ConversationSummary>(
      "/conversations",
      "POST",
      { colleagueId: id },
      anna.cookie,
    );
    expect(started.res.status).toBe(201);
    const { events } = await ask(started.body.id, "Come mi collego alla VPN?", anna.cookie);
    expect(events.at(-1)).toMatchObject({ type: "done" });

    // The profile allows full access, yet only the wiki is read, and no notes are kept.
    const request = requests.at(-1);
    expect(request?.tools?.map((tool) => tool.name).sort()).toEqual(["wiki_read", "wiki_search"]);
    expect(request?.system).toContain("Never invent");
    expect(request?.system).toContain("Sii gentile.");
    expect(request?.system).not.toContain("private notes");
    expect(request?.system).not.toContain("wiki_write");

    const own = await call<Conversation>(
      `/conversations/${started.body.id}`,
      "GET",
      undefined,
      anna.cookie,
    );
    expect(own.body.messages).toHaveLength(2);
    expect(
      (await call(`/conversations/${started.body.id}`, "GET", undefined, bruno.cookie)).res.status,
    ).toBe(404);
    const brunos = await call<ConversationSummary[]>(
      `/conversations?colleagueId=${id}`,
      "GET",
      undefined,
      bruno.cookie,
    );
    expect(brunos.body).toEqual([]);

    // Nothing of it is filed into the wiki.
    const [answer] = await deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.role, "assistant"));
    const saved = await call<ApiError>(
      `/conversations/${started.body.id}/messages/${answer?.id}/wiki`,
      "POST",
      undefined,
      anna.cookie,
    );
    expect(saved.res.status).toBe(409);
    const check = await call(`/offices/${office.id}/wiki/review/check`, "POST", {
      colleagueId: id,
    });
    expect(check.res.status).toBe(400);
  });

  it("waits for a profile when its own is deleted", async () => {
    const { profile, office, anna } = await setup();
    const { id } = (await createOfficeColleague(office.id, profile.id)).body;
    expect((await call(`/admin/profiles/${profile.id}`, "DELETE")).res.status).toBe(204);

    const offices = (await call<AdminOffice[]>("/admin/offices")).body;
    expect(offices.find((item) => item.id === office.id)?.colleague?.needsProfile).toBe(true);
    expect((await workspace(anna.cookie))[0]?.colleagues[0]?.needsProfile).toBe(true);

    const started = await call<ConversationSummary>(
      "/conversations",
      "POST",
      { colleagueId: id },
      anna.cookie,
    );
    const refused = await ask(started.body.id, "Ciao", anna.cookie);
    expect(refused.res.status).toBe(409);
  });

  it("is hidden from everyone when archived, and takes every conversation when deleted", async () => {
    const { profile, office, anna } = await setup();
    const { id } = (await createOfficeColleague(office.id, profile.id)).body;
    await call("/conversations", "POST", { colleagueId: id }, anna.cookie);

    await call(`/admin/offices/${office.id}/colleague`, "PATCH", { archived: true });
    expect((await workspace(anna.cookie))[0]?.colleagues).toEqual([]);
    const refused = await call("/conversations", "POST", { colleagueId: id }, anna.cookie);
    expect(refused.res.status).toBe(404);
    await call(`/admin/offices/${office.id}/colleague`, "PATCH", { archived: false });
    expect((await workspace(anna.cookie))[0]?.colleagues).toHaveLength(1);

    expect((await call(`/admin/offices/${office.id}/colleague`, "DELETE")).res.status).toBe(204);
    expect(await deps.db.select().from(conversations)).toEqual([]);
    expect((await workspace(anna.cookie))[0]?.colleagues).toEqual([]);
    // Another one can be set up in its place.
    expect((await createOfficeColleague(office.id, profile.id)).res.status).toBe(201);
  });
});
