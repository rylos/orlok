import { describe, expect, it } from "vitest";
import { parseImportFiles } from "./wiki-import";

describe("parseImportFiles", () => {
  it("uses folders as sections under an optional prefix", () => {
    const pages = parseImportFiles(
      [
        { path: "Servers/Linux/Proxmox.md", content: "Cluster" },
        { path: "Notes.md", content: "Loose note" },
      ],
      "IT",
    );
    expect(pages.map(({ slug, section, sources }) => ({ slug, section, sources }))).toEqual([
      { slug: "proxmox", section: "IT / Servers / Linux", sources: ["Servers/Linux/Proxmox.md"] },
      { slug: "notes", section: "IT", sources: ["Notes.md"] },
    ]);
  });

  it("reads frontmatter and keeps duplicate titles apart", () => {
    const pages = parseImportFiles(
      [
        {
          path: "a/Same.md",
          content: "---\ntitle: Same\nslug: custom-slug\nsources:\n  - https://example.com\n---\nA",
        },
        { path: "b/Same.md", content: "B" },
        { path: "c/Same.md", content: "C" },
        { path: "d/Broken.md", content: "---\n: : :\n---\nD" },
      ],
      null,
    );
    expect(pages.map((page) => page.slug)).toEqual(["custom-slug", "same", "same-2", "broken"]);
    expect(pages[0]?.sources).toEqual(["https://example.com"]);
    expect(pages[3]?.content).toBe("---\n: : :\n---\nD");
  });

  it("leaves external, image and unknown links untouched", () => {
    const content =
      "[site](https://example.com/a.md) ![img](../_resources/a.png) [missing](Other.md) [mail](mailto:a@b.c)";
    const [page] = parseImportFiles([{ path: "Page.md", content }], null);
    expect(page?.content).toBe(content);
  });

  it("links notes the way a Joplin export writes them", () => {
    // The selected folder is the notebook; links climb to the export root, file names are cut
    // short and encoded, and notes outside the notebook come out as "undefined" or ":/id".
    const pages = parseImportFiles(
      [
        {
          path: "Ufficio/Infrastruttura/XR500 OpenWrt — piano.md",
          content: [
            "- [OpenWrt — Router (`gateway-magazzino`)](../../Ufficio/Infrastruttura/OpenWrt%20—%20Router%20%28gateway-mag.md) — da ricostruire",
            "- [Inventario Dispositivi](../../undefined) — mappa",
            "- [pfSense](:/0f745d427a004141ace994779efe92bd)",
            "- [Altrove](../../undefined)",
          ].join("\n"),
        },
        {
          path: "Ufficio/Infrastruttura/OpenWrt — Router (gateway-mag.md",
          content: "---\ntitle: OpenWrt — Router (`gateway-magazzino`)\n---\nRouter",
        },
        { path: "Ufficio/Reti/Inventario Dispositivi.md", content: "Mappa" },
        { path: "Ufficio/Reti/pfSense.md", content: "Firewall" },
      ],
      null,
    );
    expect(pages[0]?.content).toBe(
      [
        "- [[openwrt-router-gateway-magazzino]] — da ricostruire",
        "- [[inventario-dispositivi]] — mappa",
        "- [[pfsense]]",
        "- Altrove",
      ].join("\n"),
    );
  });

  it("links notes the way Obsidian, Notion and plain folders write them", () => {
    const pages = parseImportFiles(
      [
        {
          path: "Vault/Daily/Today.md",
          content: [
            "[[Proxmox]] and [[Backup plan#Retention|the retention]] and ![[diagram.png]]",
            "[cluster](../Servers/Proxmox) [root](/Servers/Proxmox.md#nodes) [enc](<../Servers/Backup plan.md>)",
            "[notion](Network%20map%201a2b3c4d5e6f708192a3b4c5d6e7f809.md) [here](#top) [[Nowhere]]",
          ].join("\n"),
        },
        { path: "Vault/Servers/Proxmox.md", content: "Cluster" },
        { path: "Vault/Servers/Backup plan.md", content: "Nightly" },
        { path: "Vault/Network map 1a2b3c4d5e6f708192a3b4c5d6e7f809.md", content: "Map" },
      ],
      null,
    );
    expect(pages[0]?.content).toBe(
      [
        "[[proxmox]] and [[backup-plan|the retention]] and ![[diagram.png]]",
        "[[proxmox|cluster]] [[proxmox|root]] [[backup-plan|enc]]",
        "[[network-map|notion]] [here](#top) [[Nowhere]]",
      ].join("\n"),
    );
  });
});
