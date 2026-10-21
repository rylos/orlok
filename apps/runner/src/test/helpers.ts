import os from "node:os";
import path from "node:path";
import type { RunnerJobRequest, RunnerJobState, RunnerStreamEvent } from "@orlok/shared";
import { createRunnerApp } from "../app";
import { JobManager } from "../jobs";
import { McpSessionManager } from "../mcp";
import { Sandbox } from "../sandbox";
import { findExecutable } from "../tools";

export const TEST_TOKEN = "test-runner-token-0123456789";

export async function createTestRunner(
  options: { maxJobs?: number; maxSessions?: number; killGraceMs?: number; idleMs?: number } = {},
) {
  const searchPath = process.env.PATH ?? "/usr/bin:/bin";
  const sandbox = await Sandbox.create({
    tmpDir: os.tmpdir(),
    path: searchPath,
    prlimit: findExecutable("prlimit", searchPath),
    limits: { memoryMb: 4096, cpuSeconds: 60, fileSizeMb: 64, openFiles: 1024, processes: 0 },
    isolation: null,
  });
  const jobs = new JobManager({
    sandbox,
    maxJobs: options.maxJobs ?? 4,
    killGraceMs: options.killGraceMs ?? 5000,
    ssh: { ssh: "ssh", sshKeyscan: "ssh-keyscan", sshpass: "sshpass" },
    // A stand-in for the WinRM helper: same contract, no Windows host needed.
    winrm: { python: "python3", helper: path.join(import.meta.dirname, "fake_winrm.py") },
  });
  const mcp = new McpSessionManager({
    sandbox,
    maxSessions: options.maxSessions ?? 4,
    killGraceMs: options.killGraceMs ?? 5000,
    idleMs: options.idleMs,
  });
  const app = createRunnerApp({
    token: TEST_TOKEN,
    version: "test",
    jobs,
    mcp,
    tools: () => ["sh"],
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

  const submit = (job: Partial<RunnerJobRequest> & { command: string }) =>
    request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        id: crypto.randomUUID(),
        target: { kind: "local" },
        timeoutSeconds: 30,
        maxOutputBytes: 65_536,
        secrets: [],
        ...job,
      }),
    });

  const state = async (id: string) =>
    (await (await request(`/v1/jobs/${id}`)).json()) as RunnerJobState;

  const waitFor = async (id: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await state(id);
      if (current.finishedAt !== null) return current;
      await sleep(50);
    }
    throw new Error(`Job ${id} did not finish`);
  };

  // Submits a job and returns its final state.
  const run = async (job: Partial<RunnerJobRequest> & { command: string }) => {
    const id = job.id ?? crypto.randomUUID();
    const res = await submit({ ...job, id });
    if (res.status !== 202) throw new Error(`Submit failed: ${res.status} ${await res.text()}`);
    return waitFor(id);
  };

  const dispose = async () => {
    await Promise.all([jobs.shutdown(), mcp.shutdown()]);
    sandbox.disposeSync();
  };

  return { app, sandbox, jobs, mcp, request, submit, state, waitFor, run, dispose };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseSse(text: string): { event?: string; data: string }[] {
  const events: { event?: string; data: string }[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line && !line.startsWith(":"));
    if (lines.length === 0) continue;
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    events.push({ event, data });
  }
  return events;
}

export function parseJobStream(text: string): RunnerStreamEvent[] {
  return parseSse(text).map((event) => JSON.parse(event.data) as RunnerStreamEvent);
}
