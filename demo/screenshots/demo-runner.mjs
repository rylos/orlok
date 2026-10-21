// A stand-in for the Orlok runner (apps/runner) for the demo of `demo/seed/demo-seed.ts`: it never connects to
// anything, it waits a few seconds and answers with the made-up output of the commands the demo
// knows, so a command shows "Running" and then "Done" as it would on real hosts. Only for the
// screenshots and videos of the website, never next to a real installation.
//
//   ORLOK_RUNNER_TOKEN=<token> node demo-runner.mjs [--port 8790] [--seconds 6]
//
// The app reaches it through ORLOK_RUNNER_URL and the same ORLOK_RUNNER_TOKEN (demo/compose.yaml).

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8790" },
    token: { type: "string", default: process.env.ORLOK_RUNNER_TOKEN },
    seconds: { type: "string", default: "6" },
  },
});
if (!values.token) {
  console.error(
    "Usage: ORLOK_RUNNER_TOKEN=<token> node demo-runner.mjs [--port 8790] [--seconds 6]",
  );
  process.exit(2);
}
const runFor = Number(values.seconds) * 1_000;

// Output of the commands the demo runs, all made up.
const OUTPUTS = {
  "du -sh /var/backups/postgresql/*":
    "1.9G\t/var/backups/postgresql/intranet-2026-10-12.dump\n1.9G\t/var/backups/postgresql/intranet-2026-10-11.dump\n1.8G\t/var/backups/postgresql/intranet-2026-10-10.dump",
  "Restart-Service Spooler": "",
  "Get-Service Spooler | Select-Object Name, Status, StartType":
    "Name    Status  StartType\n----    ------  ---------\nSpooler Running Automatic",
  "Get-ADPrincipalGroupMembership grossi | Select-Object -ExpandProperty Name":
    "Domain Users\nGG_Accounting\nGG_Printers_Floor1\nGG_Share_Accounting",
};

const jobs = new Map();

function state(job) {
  const output = OUTPUTS[job.command] ?? "";
  if (job.status === "running" && Date.now() - job.started >= runFor) {
    job.status = "done";
    job.exitCode = 0;
    job.output = output;
    job.finishedAt = new Date().toISOString();
  } else if (job.status === "running") {
    // The lines come out a little at a time, as a real command writes them.
    const lines = output.split("\n").filter(Boolean);
    const shown = Math.floor((lines.length * (Date.now() - job.started)) / runFor);
    job.output = lines.slice(0, shown).join("\n");
  }
  return {
    id: job.id,
    status: job.status,
    exitCode: job.exitCode,
    output: job.output,
    truncated: false,
    hostKey: null,
    error: null,
    startedAt: new Date(job.started).toISOString(),
    finishedAt: job.finishedAt,
  };
}

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${values.token}`) {
    return send(res, 401, { error: "unauthorized" });
  }
  const url = new URL(req.url ?? "/", "http://runner");
  if (req.method === "GET" && url.pathname === "/v1/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/v1/jobs") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { id, command } = JSON.parse(body);
      jobs.set(id, {
        id,
        command,
        status: "running",
        exitCode: null,
        output: "",
        started: Date.now(),
        finishedAt: null,
      });
      console.log(`run ${command}`);
      send(res, 202);
    });
    return;
  }
  const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)(\/stop)?$/);
  const job = match ? jobs.get(decodeURIComponent(match[1])) : undefined;
  if (!job) {
    return send(res, 404, { error: "not_found" });
  }
  if (req.method === "POST" && match[2]) {
    job.status = "stopped";
    job.finishedAt = new Date().toISOString();
    return send(res, 204);
  }
  if (req.method === "GET" && !match[2]) {
    return send(res, 200, state(job));
  }
  send(res, 405, { error: "method_not_allowed" });
}).listen(Number(values.port), () => console.log(`Demo runner on port ${values.port}`));
