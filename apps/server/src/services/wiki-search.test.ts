import { describe, expect, it } from "vitest";
import {
  buildSearchIndex,
  exactTerms,
  rankPages,
  type SearchablePage,
  stem,
  termGroups,
} from "./wiki-search";

// Each case is a defect measured on real wikis with `wiki:eval`.

function page(slug: string, content: string, extra: Partial<SearchablePage> = {}): SearchablePage {
  return { slug, title: slug.replaceAll("-", " "), section: null, content, ...extra };
}

function slugs(pages: SearchablePage[], query: string, synonyms?: string[][]) {
  return rankPages(buildSearchIndex(pages), query, { synonyms }).map((found) => found.slug);
}

const filler = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(200);

describe("word search", () => {
  it("matches word forms by prefix, and drops the final vowel of short words", () => {
    expect(stem("stampanti")).toBe("stamp");
    expect(stem("banda")).toBe("band");
    expect(slugs([page("rete", "La banda del modem"), page("altro", "Niente")], "bande")).toEqual([
      "rete",
    ]);
  });

  it("does not let a very long page win just by containing every word", () => {
    const pages = [
      page("cluster-nodi", `${filler} proxmox apt update nodi ${filler} repository`),
      page("repository-fix", "apt update fallisce con exit code 100 sul proxmox: repository"),
    ];
    expect(slugs(pages, "apt update fallisce sul proxmox")[0]).toBe("repository-fix");
  });

  it("rewards the exact long identifier the prefix would flatten", () => {
    const pages = [
      page("requirements", "Requirements of the project, requirement list", { title: "Project" }),
      page("mail-groups", "Set RequireSenderAuthenticationEnabled to false on the group"),
    ];
    expect(slugs(pages, "RequireSenderAuthenticationEnabled")[0]).toBe("mail-groups");
  });

  it("finds IP addresses and codes whole", () => {
    expect(exactTerms("chi usa 10.0.0.91?").forms).toEqual(["10.0.0.91"]);
    const pages = [
      page("rete", "Rete 10.0.0.0/23, gateway 10.0.0.1, dns 10.0.0.10"),
      page("idrac", "IP iDRAC: 10.0.0.91"),
    ];
    expect(slugs(pages, "10.0.0.91")[0]).toBe("idrac");
  });

  it("matches terms of 2-3 letters only as whole words or word endings", () => {
    const pages = [
      page("precedente", "Il periodo precedente era attivo"),
      page("ced", "Il CED della palazzina"),
    ];
    expect(slugs(pages, "ced")).toEqual(["ced"]);
  });

  it("searches the rarest words of a long message, wherever they stand", () => {
    const chatter =
      "sistemata anche questa parte, ora passiamo al resto: si deve sempre attivare quello che serve ma solo alcune parti e non altre, ";
    const everyday = Array.from({ length: 12 }, (_, i) =>
      page(`note-${i}`, `${chatter} nota ${i}`),
    );
    const pages = [...everyday, page("cielo", "Cielo_Table: il controcielo si attiva con CR3031")];
    const ranked = rankPages(buildSearchIndex(pages), `${chatter} il controcielo CR3031`);
    // Both words come last in the message, after more than twelve others, and are searched.
    expect(ranked.find((found) => found.slug === "cielo")?.telling).toBe(2);
    // Pages sharing only everyday words hold no word that names a subject: retrieval skips them.
    expect(ranked.find((found) => found.slug === "note-0")?.telling).toBe(0);
  });

  it("counts a synonym group once, taking its best term", () => {
    const synonyms = [["desktop remoto", "rdp", "rustdesk"]];
    expect(termGroups("desktop remoto sul nas", synonyms)).toHaveLength(2);
    const pages = [page("rustdesk-server", "Server RustDesk self-hosted"), page("nas", "Il nas")];
    expect(slugs(pages, "desktop remoto", synonyms)).toContain("rustdesk-server");
  });

  it("ranks outdated pages after current ones", () => {
    const pages = [
      page("vpn-vecchia", "Configurazione VPN OpenVPN", { outdated: true }),
      page("vpn", "Configurazione VPN WireGuard"),
    ];
    expect(slugs(pages, "configurazione vpn")).toEqual(["vpn", "vpn-vecchia"]);
  });

  it("returns a snippet from the line that matched", () => {
    const [found] = rankPages(
      buildSearchIndex([page("ups", "# UPS\n\n**Fonti:** x\n\nAutonomia stimata: 6 minuti")]),
      "autonomia",
    );
    expect(found?.snippet).toBe("Autonomia stimata: 6 minuti");
  });
});
