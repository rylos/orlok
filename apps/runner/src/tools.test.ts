import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { availableTools, declaredTools } from "./tools";

// A derived image declares the tools it adds (`FROM orlok-runner`); only those really found on
// PATH are reported.
describe("declared tools", () => {
  it("reads names from files and the environment, skipping comments and odd names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orlok-tools-"));
    writeFileSync(
      path.join(dir, "vendor.list"),
      "az\n# the Azure CLI\nkubectl # clusters\n\n$(boom)\n",
    );
    writeFileSync(path.join(dir, ".hidden"), "ignored\n");
    expect(declaredTools(dir, "terraform, az")).toEqual(["terraform", "az", "kubectl"]);
    expect(declaredTools(path.join(dir, "missing"), undefined)).toEqual([]);
  });

  it("reports only what is on PATH", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "orlok-bin-"));
    writeFileSync(path.join(bin, "vendorctl"), "#!/bin/sh\n", { mode: 0o755 });
    const tools = availableTools(bin, ["vendorctl", "not-installed"]);
    expect(tools).toEqual(["vendorctl"]);
  });
});
