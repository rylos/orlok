import type { RunnerJobState } from "@orlok/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET_MARKER, TRUNCATION_MARKER } from "./output";
import { createTestRunner, parseJobStream, sleep, TEST_TOKEN } from "./test/helpers";

type Runner = Awaited<ReturnType<typeof createTestRunner>>;

function processGroupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("local jobs", () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await createTestRunner({ maxJobs: 2, killGraceMs: 1000 });
  });

  afterAll(async () => {
    await runner.dispose();
  });

  it("serves health without a token", async () => {
    const res = await runner.app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "test", tools: ["sh"] });
  });

  it("rejects missing and wrong tokens", async () => {
    expect((await runner.app.request("/v1/jobs/x")).status).toBe(401);
    const wrong = await runner.app.request("/v1/jobs/x", {
      headers: { Authorization: `Bearer ${TEST_TOKEN}-nope` },
    });
    expect(wrong.status).toBe(401);
  });

  it("answers 404 for unknown jobs", async () => {
    expect((await runner.request("/v1/jobs/unknown")).status).toBe(404);
    expect((await runner.request("/v1/jobs/unknown/stream")).status).toBe(404);
    expect((await runner.request("/v1/jobs/unknown/stop", { method: "POST" })).status).toBe(404);
  });

  it("validates the body", async () => {
    const res = await runner.request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ id: "x", command: "" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_body" });
  });

  it("rejects duplicate ids", async () => {
    const id = crypto.randomUUID();
    expect((await runner.submit({ id, command: "true" })).status).toBe(202);
    expect((await runner.submit({ id, command: "true" })).status).toBe(409);
    await runner.waitFor(id);
  });

  it("runs a command with a minimal environment in a fresh directory", async () => {
    const state = await runner.run({
      command: 'echo hello; pwd; echo "home=$HOME"; env | sort | cut -d= -f1; echo oops >&2',
    });
    expect(state.status).toBe("done");
    expect(state.exitCode).toBe(0);
    expect(state.error).toBeNull();
    const lines = state.output.split("\n");
    expect(lines[0]).toBe("hello");
    expect(lines[2]).toBe(`home=${lines[1]}`);
    // stdout and stderr are separate pipes, so only arrival order is kept.
    expect(lines).toContain("oops");
    expect(state.output).not.toContain("ORLOK");
    expect(state.output).toContain("LANG");
    expect(state.output).not.toContain("VITEST");
  });

  it("reports exit codes", async () => {
    const state = await runner.run({ command: "exit 7" });
    expect(state).toMatchObject({ status: "done", exitCode: 7 });
  });

  it("masks secrets in the stored output", async () => {
    const state = await runner.run({
      command: "echo token=abc123XYZ; printf abc123XYZ | base64",
      secrets: ["abc123XYZ"],
    });
    expect(state.output).toBe(`token=${SECRET_MARKER}\n${SECRET_MARKER}\n`);
  });

  it("caps the output", async () => {
    const state = await runner.run({
      command: "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done",
      maxOutputBytes: 1000,
    });
    expect(state.truncated).toBe(true);
    expect(state.output).toContain(TRUNCATION_MARKER);
    expect(state.output.startsWith("line-0\n")).toBe(true);
    expect(state.output.endsWith("line-1999\n")).toBe(true);
  });

  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    const state = await runner.run({ command: "echo $$; sleep 30 & sleep 30", timeoutSeconds: 1 });
    expect(state.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pgid = Number(state.output.trim());
    expect(pgid).toBeGreaterThan(0);
    expect(processGroupAlive(pgid)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const id = crypto.randomUUID();
    await runner.submit({ id, command: "trap '' TERM; echo ready; sleep 30 & wait" });
    await sleep(300);
    const res = await runner.request(`/v1/jobs/${id}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const state = (await res.json()) as RunnerJobState;
    expect(state).toMatchObject({ status: "stopped" });
    expect(state.finishedAt).not.toBeNull();
  });

  it("stops a running job", async () => {
    const id = crypto.randomUUID();
    await runner.submit({ id, command: "echo started; sleep 30" });
    await sleep(300);
    const res = await runner.request(`/v1/jobs/${id}/stop`, { method: "POST" });
    const state = await res.json();
    expect(state).toMatchObject({ status: "stopped", output: "started\n" });
  });

  it("queues jobs over the concurrency limit", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await runner.submit({ id, command: "echo run; sleep 1" });
    await sleep(300);
    const waiting = await runner.state(ids[2] as string);
    expect(waiting).toMatchObject({ status: "running", output: "" });
    // A queued job can be stopped before it starts.
    const stopped = await (
      await runner.request(`/v1/jobs/${ids[2]}/stop`, { method: "POST" })
    ).json();
    expect(stopped).toMatchObject({ status: "stopped", output: "", exitCode: null });
    const first = await runner.waitFor(ids[0] as string);
    expect(first.output).toBe("run\n");
  });

  it("streams replayed and live output, then the end event", async () => {
    const id = crypto.randomUUID();
    await runner.submit({ id, command: "echo one; sleep 0.5; echo two" });
    await sleep(250);
    const res = await runner.request(`/v1/jobs/${id}/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseJobStream(await res.text());
    const output = events
      .filter((event) => event.type === "output")
      .map((event) => (event.type === "output" ? event.data : ""))
      .join("");
    expect(output).toBe("one\ntwo\n");
    const end = events.at(-1);
    expect(end?.type).toBe("end");
    if (end?.type === "end") expect(end.state).toMatchObject({ status: "done", exitCode: 0 });

    // A finished job replays everything and ends at once.
    const again = parseJobStream(await (await runner.request(`/v1/jobs/${id}/stream`)).text());
    expect(again.map((event) => event.type)).toEqual(["output", "end"]);
  });
});
