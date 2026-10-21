import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRunner, parseSse, sleep } from "./test/helpers";

// Answers every JSON-RPC request with its params, logs to stderr, exits on "shutdown".
const ECHO_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.error("echo server ready, secret=" + process.env.ECHO_SECRET + ", home=" + process.env.HOME);
console.log("not json");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "shutdown") process.exit(4);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params }) + "\\n");
});
`;

describe("MCP stdio bridge", () => {
  let dir: string;
  let script: string;
  let runner: Awaited<ReturnType<typeof createTestRunner>>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "orlok-runner-mcp-"));
    script = path.join(dir, "echo.cjs");
    await writeFile(script, ECHO_SERVER);
    runner = await createTestRunner({ maxSessions: 2, killGraceMs: 1000 });
  });

  afterAll(async () => {
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const create = (id: string) =>
    runner.request("/v1/mcp/sessions", {
      method: "POST",
      body: JSON.stringify({
        id,
        command: process.execPath,
        args: [script],
        env: { ECHO_SECRET: "from-env" },
      }),
    });

  const send = (id: string, message: unknown) =>
    runner.request(`/v1/mcp/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify(message),
    });

  it("round-trips JSON-RPC messages and reports the exit", async () => {
    const id = crypto.randomUUID();
    expect((await create(id)).status).toBe(201);
    expect((await create(id)).status).toBe(409);

    expect(
      (await send(id, { jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } })).status,
    ).toBe(202);
    expect((await send(id, { jsonrpc: "2.0", id: 2, method: "ping", params: "é" })).status).toBe(
      202,
    );
    expect((await send(id, [1, 2])).status).toBe(400);
    await sleep(500);
    await send(id, { jsonrpc: "2.0", method: "shutdown" });

    // Events produced before anyone listened are replayed; the stream closes after "exit".
    const events = parseSse(await (await runner.request(`/v1/mcp/sessions/${id}/events`)).text());
    const messages = events
      .filter((event) => event.event === undefined)
      .map((e) => JSON.parse(e.data));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: { a: 1 } },
      { jsonrpc: "2.0", id: 2, result: "é" },
    ]);
    const logs = events.filter((event) => event.event === "log").map((event) => event.data);
    expect(logs).toContain("not json");
    const ready = logs.find((line) => line.startsWith("echo server ready"));
    expect(ready).toContain("secret=from-env");
    const home = /home=(.*)$/.exec(ready ?? "")?.[1] as string;
    expect(events.at(-1)).toEqual({
      event: "exit",
      data: JSON.stringify({ code: 4, signal: null }),
    });
    // The session's working directory is removed after the exit.
    await sleep(100);
    expect(existsSync(home)).toBe(false);
    expect((await send(id, { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(409);
  });

  it("streams live events and deletes sessions", async () => {
    const id = crypto.randomUUID();
    await create(id);
    const res = await runner.request(`/v1/mcp/sessions/${id}/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    await send(id, { jsonrpc: "2.0", id: 7, method: "ping", params: { live: true } });
    while (!text.includes('"id":7')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('data: {"jsonrpc":"2.0","id":7,"result":{"live":true}}');

    expect((await runner.request(`/v1/mcp/sessions/${id}`, { method: "DELETE" })).status).toBe(204);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("event: exit");
    expect((await runner.request(`/v1/mcp/sessions/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await send(id, { jsonrpc: "2.0", id: 8, method: "ping" })).status).toBe(404);
  });

  it("limits the number of sessions", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    expect((await create(ids[0] as string)).status).toBe(201);
    expect((await create(ids[1] as string)).status).toBe(201);
    expect((await create(ids[2] as string)).status).toBe(429);
    for (const id of ids.slice(0, 2)) {
      await runner.request(`/v1/mcp/sessions/${id}`, { method: "DELETE" });
    }
  });

  it("kills idle sessions", async () => {
    const idle = await createTestRunner({ idleMs: 300, killGraceMs: 500 });
    try {
      const id = crypto.randomUUID();
      await idle.request("/v1/mcp/sessions", {
        method: "POST",
        body: JSON.stringify({ id, command: process.execPath, args: [script], env: {} }),
      });
      await sleep(1500);
      const res = await idle.request(`/v1/mcp/sessions/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(404);
      expect(idle.mcp.activeCount).toBe(0);
    } finally {
      await idle.dispose();
    }
  });
});
