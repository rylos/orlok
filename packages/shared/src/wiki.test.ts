import { describe, expect, it } from "vitest";
import { extractWikiLinks, slugify } from "./wiki";

describe("slugify", () => {
  it("keeps ASCII words joined by hyphens", () => {
    expect(slugify("Cluster Proxmox (sede)")).toBe("cluster-proxmox-sede");
    expect(slugify("Perché la VPN non funziona?")).toBe("perche-la-vpn-non-funziona");
    expect(slugify("  --  ")).toBe("page");
  });

  it("limits the length without a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(119)} b`);
    expect(slug).toBe("a".repeat(119));
  });
});

describe("extractWikiLinks", () => {
  it("collects slugified targets and ignores code", () => {
    const content = [
      "See [[proxmox-cluster]] and [[Backup Veeam|the backups]].",
      "Again [[proxmox-cluster]].",
      "`[[inline-code]]`",
      "```",
      "[[fenced-code]]",
      "```",
    ].join("\n");
    expect(extractWikiLinks(content)).toEqual(["proxmox-cluster", "backup-veeam"]);
  });
});
