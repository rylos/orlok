import { describe, expect, it } from "vitest";
import {
  addressConflicts,
  hostsWithoutPage,
  isStaleVerification,
  relativeDateLines,
} from "./wiki-lint";

const page = (slug: string, content: string, title = slug) => ({ slug, title, content });

describe("address conflicts", () => {
  it("reports a host given two addresses in the same network by different pages", () => {
    const conflicts = addressConflicts([
      page("a", "| nas01 | 10.0.0.240 |"),
      page("b", "nas01 → 10.0.0.241"),
      page("c", "nas01: 10.0.0.240"),
    ]);
    expect(conflicts).toEqual([
      {
        host: "nas01",
        addresses: [
          { ip: "10.0.0.240", slugs: ["a", "c"] },
          { ip: "10.0.0.241", slugs: ["b"] },
        ],
      },
    ]);
  });

  it("ignores ambiguous forms, public addresses and one page contradicting itself", () => {
    expect(
      addressConflicts([
        // The address belongs to the container, not to app03.
        page("a", "CT 100 on app03 (10.0.0.30)"),
        page("b", "app03: 10.0.0.9"),
        // A user, not a host.
        page("c", "ssh admin@10.0.0.8"),
        page("d", "www: 52.49.7.237"),
        page("e", "www: 52.49.7.238"),
        page("f", "gw: 10.0.1.1\ngw: 10.0.1.254"),
      ]),
    ).toEqual([]);
  });

  it("finds hosts mentioned in many pages without a page of their own", () => {
    const pages = [
      page("net", "dc01: 10.0.0.10"),
      ...["a", "b", "c"].map((slug) => page(slug, "Joined to dc01.")),
    ];
    expect(hostsWithoutPage(pages)).toEqual([{ host: "dc01", slugs: ["net", "a", "b", "c"] }]);
    expect(
      hostsWithoutPage([...pages, page("dc01", "The DC", "dc01 — domain controller")]),
    ).toEqual([]);
  });
});

describe("dates", () => {
  it("finds relative dates without an absolute one on the same line, outside code", () => {
    const content = [
      "The NAS currently runs DSM 7.",
      "Currently (2026-09-21) on DSM 7.2.",
      "Moved last week, in September 2026.",
      "```",
      "echo currently",
      "```",
      "Oggi | Domani",
    ].join("\n");
    expect(relativeDateLines(content)).toEqual(["The NAS currently runs DSM 7."]);
  });

  it("considers a verification older than a year stale", () => {
    const today = new Date("2026-09-30T10:00:00Z");
    expect(isStaleVerification("2025-09-01", today)).toBe(true);
    expect(isStaleVerification("2026-01-01", today)).toBe(false);
    expect(isStaleVerification(null, today)).toBe(false);
  });
});
