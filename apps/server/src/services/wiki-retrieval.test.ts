import { describe, expect, it } from "vitest";
import { conversationQuery, passageFor } from "./wiki-retrieval";

// What of the wiki reaches the colleague (R-MEM-4).
describe("conversationQuery", () => {
  it("searches the question before a short follow-up", () => {
    expect(conversationQuery("e su bak06?", ["Come si riavvia il backup di bak05?"])).toBe(
      "Come si riavvia il backup di bak05?\ne su bak06?",
    );
    const long =
      "Come si configura la stampante konika4701 per la stampa fronte retro sul piano terra?";
    expect(conversationQuery(long, ["prima domanda"])).toBe(long);
    expect(conversationQuery("ciao", [])).toBe("ciao");
  });
});

describe("passageFor", () => {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `Riga ${i} di inventario senza nulla di speciale.`);
  const page = [
    "# Server di reparto",
    "Elenco dei server e delle loro configurazioni.",
    ...filler(150),
    "## bak06",
    "bak06 esegue il backup notturno su PBS alle 23:00.",
    "Il restore si lancia da proxmox-backup-client.",
    ...filler(150),
  ].join("\n");

  it("keeps a short page whole", () => {
    expect(passageFor("Breve.", "backup", 1_000)).toBe("Breve.");
  });

  it("gives the beginning and the lines that match, within the limit", () => {
    const passage = passageFor(page, "backup bak06 restore", 2_000);
    expect(passage.length).toBeLessThanOrEqual(2_000);
    expect(passage.startsWith("# Server di reparto")).toBe(true);
    expect(passage).toContain("bak06 esegue il backup notturno su PBS alle 23:00.");
    expect(passage).toContain("[…]");
    expect(passage.endsWith("[… truncated]")).toBe(true);
  });

  it("falls back to the beginning when nothing matches", () => {
    const passage = passageFor(page, "stampante", 1_000);
    expect(passage.startsWith("# Server di reparto")).toBe(true);
    expect(passage).not.toContain("bak06");
  });
});
