import type { WikiPageType } from "@orlok/shared";
import { describe, expect, it } from "vitest";
import { computeGraph, expandScores } from "./wiki-graph";

function page(slug: string, type: WikiPageType, sources: string[] = []) {
  return { slug, title: slug.toUpperCase(), type, section: null, sources };
}

const pages = [
  page("vpn", "procedure", ["Document: network.pdf"]),
  page("firewall", "entity", ["Document: network.pdf"]),
  page("wireguard", "entity"),
  page("printers", "entity"),
  page("toner", "note"),
  page("lonely", "note"),
];

const links = [
  { from: "vpn", to: "firewall" },
  { from: "firewall", to: "vpn" },
  { from: "vpn", to: "wireguard" },
  { from: "firewall", to: "wireguard" },
  { from: "printers", to: "toner" },
  { from: "toner", to: "missing-page" },
];

describe("computeGraph", () => {
  const graph = computeGraph({ pages, links, semantic: [] });
  const edge = (a: string, b: string) =>
    graph.edges.find(
      (item) =>
        (item.source === a && item.target === b) || (item.source === b && item.target === a),
    );

  it("combines links, shared sources, common neighbors and type affinity", () => {
    expect(edge("vpn", "firewall")?.signals).toEqual({
      links: 2,
      sources: 1,
      adamicAdar: Math.round(Math.LOG2E * 1000) / 1000,
      type: 0,
      semantic: 0,
    });
    expect(edge("vpn", "firewall")?.weight).toBeCloseTo(2 * 3 + 4 + Math.LOG2E * 1.5, 2);
    expect(edge("firewall", "wireguard")?.signals).toMatchObject({ links: 1, type: 1 });
    expect(edge("printers", "toner")?.weight).toBe(3);
    // Same type alone does not relate two pages.
    expect(edge("printers", "wireguard")).toBeUndefined();
    expect(graph.edges[0]).toMatchObject({ source: "firewall", target: "vpn" });
  });

  it("finds communities, isolated pages and degrees", () => {
    const communityOf = new Map(graph.nodes.map((node) => [node.slug, node.community]));
    expect(communityOf.get("vpn")).toBe(communityOf.get("wireguard"));
    expect(communityOf.get("printers")).toBe(communityOf.get("toner"));
    expect(communityOf.get("vpn")).not.toBe(communityOf.get("printers"));
    expect(graph.communities[0]).toMatchObject({ id: 0, size: 3, cohesion: 1 });
    expect(graph.insights.isolated.sort()).toEqual(["lonely", "printers", "toner"]);
    expect(graph.nodes.find((node) => node.slug === "vpn")?.degree).toBe(2);
  });

  it("adds semantic similarity and reports cross-community connections", () => {
    const semantic = computeGraph({
      pages,
      links,
      semantic: [{ a: "wireguard", b: "printers", similarity: 0.9 }],
    });
    const bridge = semantic.edges.find(
      (item) => item.signals.semantic === 1 && [item.source, item.target].includes("printers"),
    );
    expect(bridge?.weight).toBeCloseTo(1 * 2 + 1, 5);
    expect(computeGraph({ pages, links: [], semantic: [] }).edges).toEqual([
      expect.objectContaining({ source: "firewall", target: "vpn", weight: 4 }),
    ]);
  });
});

describe("expandScores", () => {
  it("spreads scores to neighbors with decay", () => {
    const graph = computeGraph({ pages, links, semantic: [] });
    const scores = expandScores(graph, new Map([["printers", 1]]));
    const maxWeight = graph.edges[0]?.weight ?? 1;
    expect(scores.get("printers")).toBe(1);
    expect(scores.get("toner")).toBeCloseTo(0.5 * (3 / maxWeight), 5);
    expect(scores.has("vpn")).toBe(false);
  });
});
