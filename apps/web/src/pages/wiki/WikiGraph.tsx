import {
  WIKI_PAGE_TYPES,
  type WikiGraph as WikiGraphData,
  type WikiPageType,
  type WikiSurpriseReason,
} from "@orlok/shared";
import { UndirectedGraph } from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import {
  ArrowLeftRight,
  ExternalLink,
  LoaderCircle,
  Maximize,
  Network,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import Sigma from "sigma";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { CameraState, EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { ErrorAlert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import { useWikiGraph } from "@/lib/wiki-graph-queries";
import { useWiki, WikiLoader } from "./shared";

// Knowledge graph of the office wiki (R-MEM-9): sigma.js (WebGL) on a graphology graph,
// ForceAtlas2 layout in a web worker, colors from the theme palette in index.css.

type ColorMode = "type" | "community";

type NodeAttributes = {
  label: string;
  x: number;
  y: number;
  size: number;
  pageType: WikiPageType;
  community: number;
  degree: number;
};

type EdgeAttributes = {
  weight: number;
  // Weight relative to the heaviest edge, 0-1.
  strength: number;
};

type Point = { x: number; y: number };

type Rgb = [number, number, number];

type ThemePalette = {
  categories: string[];
  other: string;
  dimmed: string;
  foreground: Rgb;
  edge: Rgb;
  card: string;
  border: string;
  font: string;
};

const PALETTE_SIZE = 12;
const MIN_NODE_SIZE = 3;
const MAX_NODE_SIZE = 20;
const LIST_LIMIT = 8;
const NEIGHBOR_LIMIT = 8;
const SEARCH_LIMIT = 8;

// Positions and camera survive refetches and navigation away and back, for the whole visit.
const positionCache = new Map<string, Map<string, Point>>();
const cameraCache = new Map<string, CameraState>();

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return (value >>> 0) / 4294967295;
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits });
}

function formatPercent(value: number) {
  return value.toLocaleString(i18n.resolvedLanguage, {
    style: "percent",
    maximumFractionDigits: 0,
  });
}

// --- Theme colors --------------------------------------------------------------------------

let colorContext: CanvasRenderingContext2D | null = null;

// Any CSS color → RGB, using the browser's own parser.
function toRgb(value: string): Rgb {
  colorContext ??= document.createElement("canvas").getContext("2d");
  if (!colorContext) {
    return [128, 128, 128];
  }
  colorContext.fillStyle = "#808080";
  colorContext.fillStyle = value;
  const normalized = colorContext.fillStyle;
  if (normalized.startsWith("#")) {
    const number = Number.parseInt(normalized.slice(1, 7), 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }
  const [r = 128, g = 128, b = 128] = normalized.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [r, g, b];
}

function rgba([r, g, b]: Rgb, alpha: number) {
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function readPalette(): ThemePalette {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  const background = toRgb(token("--background"));
  const muted = toRgb(token("--muted-foreground"));
  // Dimmed nodes: muted color blended into the background.
  const blend = (index: 0 | 1 | 2) => Math.round(muted[index] * 0.22 + background[index] * 0.78);
  const dimmed: Rgb = [blend(0), blend(1), blend(2)];
  return {
    categories: Array.from({ length: PALETTE_SIZE }, (_, index) =>
      rgba(toRgb(token(`--graph-${index + 1}`)), 1),
    ),
    other: rgba(muted, 1),
    dimmed: rgba(dimmed, 1),
    foreground: toRgb(token("--foreground")),
    edge: muted,
    card: token("--card"),
    border: token("--border"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

// Re-read the tokens whenever the theme on <html> changes.
function useThemePalette() {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, []);
  return palette;
}

function paletteVar(index: number) {
  return index < 0 ? "var(--muted-foreground)" : `var(--graph-${index + 1})`;
}

function hoverDrawer(palette: ThemePalette): NodeHoverDrawingFunction {
  return (context, data, settings) => {
    const size = settings.labelSize;
    const padding = 4;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    context.beginPath();
    context.arc(data.x, data.y, data.size + 2, 0, Math.PI * 2);
    context.strokeStyle = rgba(palette.foreground, 0.9);
    context.lineWidth = 2;
    context.stroke();
    if (!data.label) {
      return;
    }
    const width = context.measureText(data.label).width;
    const left = data.x + data.size + 6;
    context.beginPath();
    context.roundRect(
      left - padding,
      data.y - size / 2 - padding,
      width + padding * 2,
      size + padding * 2,
      4,
    );
    context.fillStyle = palette.card;
    context.fill();
    context.strokeStyle = palette.border;
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = rgba(palette.foreground, 1);
    context.textBaseline = "middle";
    context.fillText(data.label, left, data.y);
  };
}

// --- Graph model ---------------------------------------------------------------------------

function groupKey(mode: ColorMode, node: { pageType: WikiPageType; community: number }) {
  return mode === "type" ? `type:${node.pageType}` : `community:${node.community}`;
}

// Palette index per legend group: page types in their fixed order, communities by size.
function buildColorIndex(data: WikiGraphData) {
  const index = new Map<string, number>();
  WIKI_PAGE_TYPES.forEach((type, position) => {
    index.set(`type:${type}`, position % PALETTE_SIZE);
  });
  [...data.communities]
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .forEach((community, position) => {
      index.set(`community:${community.id}`, position < PALETTE_SIZE ? position : -1);
    });
  return index;
}

function nodeSize(degree: number) {
  return degree === 0
    ? MIN_NODE_SIZE
    : Math.min(MAX_NODE_SIZE, MIN_NODE_SIZE + 2.2 * Math.sqrt(degree));
}

// Starting positions: cached ones, next to a cached neighbor, or on a ring per community.
function initialPositions(data: WikiGraphData, cached: Map<string, Point> | undefined) {
  const positions = new Map<string, Point>();
  const neighbors = new Map<string, string[]>();
  for (const edge of data.edges) {
    neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
  }
  const communities = [...new Set(data.nodes.map((node) => node.community))].sort((a, b) => a - b);
  const radius = 40 * Math.sqrt(communities.length + 1);
  let missing = 0;
  for (const node of data.nodes) {
    const known = cached?.get(node.slug);
    if (known) {
      positions.set(node.slug, known);
      continue;
    }
    missing++;
    const jitterX = hash(node.slug) - 0.5;
    const jitterY = hash(`${node.slug}#`) - 0.5;
    const placed = (neighbors.get(node.slug) ?? [])
      .map((slug) => cached?.get(slug))
      .filter((point): point is Point => point !== undefined);
    if (placed.length > 0) {
      const x = placed.reduce((sum, point) => sum + point.x, 0) / placed.length;
      const y = placed.reduce((sum, point) => sum + point.y, 0) / placed.length;
      positions.set(node.slug, { x: x + jitterX * 5, y: y + jitterY * 5 });
      continue;
    }
    const angle = (2 * Math.PI * communities.indexOf(node.community)) / communities.length;
    positions.set(node.slug, {
      x: Math.cos(angle) * radius + jitterX * 30,
      y: Math.sin(angle) * radius + jitterY * 30,
    });
  }
  return { positions, missing };
}

function buildGraph(data: WikiGraphData, positions: Map<string, Point>) {
  const graph = new UndirectedGraph<NodeAttributes, EdgeAttributes>();
  for (const node of data.nodes) {
    const point = positions.get(node.slug) ?? { x: 0, y: 0 };
    graph.mergeNode(node.slug, {
      label: node.title,
      x: point.x,
      y: point.y,
      size: nodeSize(node.degree),
      pageType: node.type,
      community: node.community,
      degree: node.degree,
    });
  }
  const maxWeight = Math.max(0, ...data.edges.map((edge) => edge.weight)) || 1;
  for (const edge of data.edges) {
    if (edge.source === edge.target || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      continue;
    }
    graph.mergeEdge(edge.source, edge.target, {
      weight: edge.weight,
      strength: edge.weight / maxWeight,
    });
  }
  return graph;
}

function savePositions(officeId: string, graph: UndirectedGraph<NodeAttributes, EdgeAttributes>) {
  const positions = new Map<string, Point>();
  graph.forEachNode((node, attributes) => {
    positions.set(node, { x: attributes.x, y: attributes.y });
  });
  positionCache.set(officeId, positions);
}

// State read by the sigma reducers; kept in a ref so changes only need a refresh.
type ViewState = {
  mode: ColorMode;
  highlight: string | null;
  active: string | null;
  neighbors: ReadonlySet<string>;
  palette: ThemePalette;
  colorIndex: ReadonlyMap<string, number>;
};

// --- Route ---------------------------------------------------------------------------------

export function WikiGraph() {
  const { t } = useTranslation();
  const { officeId, base, overview } = useWiki();
  const graph = useWikiGraph(officeId);

  if (graph.isPending) {
    return <WikiLoader />;
  }
  if (graph.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ErrorAlert>{translateError(t, graph.error)}</ErrorAlert>
      </div>
    );
  }
  if (graph.data.nodes.length === 0 || graph.data.edges.length === 0) {
    const noPages = graph.data.nodes.length === 0;
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <GraphHeading />
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <Network className="mx-auto size-8 text-primary" aria-hidden />
          <p className="font-medium">
            {noPages ? t("wiki.graph.emptyPages") : t("wiki.graph.emptyEdges")}
          </p>
          <p className="text-sm text-muted-foreground">
            {noPages ? t("wiki.graph.emptyPagesHint") : t("wiki.graph.emptyEdgesHint")}
          </p>
          {noPages && overview.canEdit ? (
            <Link to={`${base}/_new`} className={buttonClasses("primary", "sm")}>
              {t("wiki.newPage")}
            </Link>
          ) : null}
        </div>
      </div>
    );
  }
  return <GraphView key={officeId} data={graph.data} />;
}

function GraphHeading({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 id="wiki-graph-title" className="text-2xl font-semibold tracking-tight">
          {t("wiki.graph.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("wiki.graph.description")}</p>
      </div>
      {children}
    </div>
  );
}

// --- Graph view ----------------------------------------------------------------------------

function GraphView({ data }: { data: WikiGraphData }) {
  const { t } = useTranslation();
  const { officeId, base } = useWiki();
  const navigate = useNavigate();
  const palette = useThemePalette();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  // Coloring by type says nothing when every page has the same type (e.g. after an import).
  const [mode, setMode] = useState<ColorMode>(() =>
    new Set(data.nodes.map((node) => node.type)).size > 1 ? "type" : "community",
  );
  const [highlight, setHighlight] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);

  const colorIndex = useMemo(() => buildColorIndex(data), [data]);
  const nodesBySlug = useMemo(() => new Map(data.nodes.map((node) => [node.slug, node])), [data]);
  const communitiesById = useMemo(
    () => new Map(data.communities.map((community) => [community.id, community])),
    [data],
  );
  const active = selected ?? hovered;

  const neighborWeights = useMemo(() => {
    if (!active) {
      return [];
    }
    return data.edges
      .filter((edge) => edge.source === active || edge.target === active)
      .map((edge) => ({
        slug: edge.source === active ? edge.target : edge.source,
        weight: edge.weight,
      }))
      .sort((a, b) => b.weight - a.weight);
  }, [active, data]);

  const viewRef = useRef<ViewState>({
    mode,
    highlight,
    active,
    neighbors: new Set(),
    palette,
    colorIndex,
  });

  // Sigma instance and layout, rebuilt when the data changes (positions come from the cache).
  // Palette changes are applied by the theme effect below, without rebuilding.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const { positions, missing } = initialPositions(data, positionCache.get(officeId));
    const graph = buildGraph(data, positions);

    const nodeReducer = (node: string, attributes: NodeAttributes): Partial<NodeDisplayData> => {
      const view = viewRef.current;
      const index = view.colorIndex.get(groupKey(view.mode, attributes)) ?? -1;
      const color =
        index < 0 ? view.palette.other : (view.palette.categories[index] ?? view.palette.other);
      const display: Partial<NodeDisplayData> = { ...attributes, color, zIndex: 1 };
      if (view.active) {
        if (node === view.active) {
          return { ...display, highlighted: true, forceLabel: true, zIndex: 3 };
        }
        if (view.neighbors.has(node)) {
          return { ...display, forceLabel: view.neighbors.size <= 12, zIndex: 2 };
        }
        return { ...display, color: view.palette.dimmed, label: null, zIndex: 0 };
      }
      if (view.highlight && groupKey(view.mode, attributes) !== view.highlight) {
        return { ...display, color: view.palette.dimmed, label: null, zIndex: 0 };
      }
      return display;
    };

    const edgeReducer = (edge: string, attributes: EdgeAttributes): Partial<EdgeDisplayData> => {
      const view = viewRef.current;
      const size = 0.5 + 3 * attributes.strength;
      const color = rgba(view.palette.edge, 0.15 + 0.55 * attributes.strength);
      const [source, target] = graph.extremities(edge);
      if (view.active) {
        return source === view.active || target === view.active
          ? {
              size: size + 0.5,
              color: rgba(view.palette.edge, 0.6 + 0.4 * attributes.strength),
              zIndex: 1,
            }
          : { hidden: true };
      }
      if (view.highlight) {
        const inside =
          groupKey(view.mode, graph.getNodeAttributes(source)) === view.highlight &&
          groupKey(view.mode, graph.getNodeAttributes(target)) === view.highlight;
        return inside ? { size, color } : { size, color: rgba(view.palette.edge, 0.05) };
      }
      return { size, color };
    };

    let sigma: Sigma<NodeAttributes, EdgeAttributes>;
    try {
      const current = viewRef.current.palette;
      sigma = new Sigma(graph, container, {
        allowInvalidContainer: true,
        defaultEdgeType: "line",
        zIndex: true,
        labelColor: { color: rgba(current.foreground, 1) },
        labelFont: current.font,
        labelSize: 13,
        labelRenderedSizeThreshold: 9,
        defaultDrawNodeHover: hoverDrawer(current),
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
        stagePadding: 24,
        nodeReducer,
        edgeReducer,
      });
    } catch {
      setRenderFailed(true);
      return;
    }
    sigmaRef.current = sigma;
    const camera = cameraCache.get(officeId);
    if (camera) {
      sigma.getCamera().setState(camera);
    }

    sigma.on("enterNode", ({ node }) => {
      container.style.cursor = "pointer";
      setHovered(node);
    });
    sigma.on("leaveNode", () => {
      container.style.cursor = "";
      setHovered(null);
    });
    sigma.on("clickNode", ({ node }) => navigate(`${base}/${node}`));
    sigma.on("clickStage", () => setSelected(null));

    const resizeObserver = new ResizeObserver(() => sigma.resize());
    resizeObserver.observe(container);

    let layout: FA2Layout<NodeAttributes, EdgeAttributes> | null = null;
    let timer: number | undefined;
    if (missing > 0) {
      const settings = { ...forceAtlas2.inferSettings(graph), edgeWeightInfluence: 1 };
      if (prefersReducedMotion() || typeof Worker === "undefined") {
        forceAtlas2.assign(graph, {
          iterations: Math.max(50, Math.min(500, Math.round(60_000 / graph.order))),
          settings,
        });
        savePositions(officeId, graph);
      } else {
        layout = new FA2Layout(graph, { settings });
        layout.start();
        setLayoutRunning(true);
        timer = window.setTimeout(
          () => {
            layout?.stop();
            savePositions(officeId, graph);
            setLayoutRunning(false);
          },
          Math.min(5000, 1500 + graph.order * 8),
        );
      }
    }

    return () => {
      window.clearTimeout(timer);
      layout?.kill();
      resizeObserver.disconnect();
      savePositions(officeId, graph);
      cameraCache.set(officeId, sigma.getCamera().getState());
      sigma.kill();
      sigmaRef.current = null;
      setLayoutRunning(false);
    };
  }, [data, officeId, base, navigate]);

  // Theme: new label colors and hover drawing.
  useEffect(() => {
    const sigma = sigmaRef.current;
    viewRef.current = { ...viewRef.current, palette };
    if (sigma) {
      sigma.setSetting("labelColor", { color: rgba(palette.foreground, 1) });
      sigma.setSetting("labelFont", palette.font);
      sigma.setSetting("defaultDrawNodeHover", hoverDrawer(palette));
    }
  }, [palette]);

  // Interaction state → reducers.
  useEffect(() => {
    const sigma = sigmaRef.current;
    const graph = sigma?.getGraph();
    viewRef.current = {
      ...viewRef.current,
      mode,
      highlight,
      active,
      colorIndex,
      neighbors: new Set(active && graph?.hasNode(active) ? graph.neighbors(active) : []),
    };
    sigma?.refresh();
  }, [mode, highlight, active, colorIndex]);

  const focusNode = useCallback((slug: string) => {
    setSelected(slug);
    const sigma = sigmaRef.current;
    const display = sigma?.getNodeDisplayData(slug);
    if (!sigma || !display) {
      return;
    }
    const camera = sigma.getCamera();
    camera.animate(
      { x: display.x, y: display.y, ratio: Math.min(camera.getState().ratio, 0.5) },
      { duration: prefersReducedMotion() ? 0 : 500 },
    );
  }, []);

  const focusCommunity = useCallback((id: number) => {
    setSelected(null);
    setMode("community");
    setHighlight(`community:${id}`);
    sigmaRef.current?.getCamera().animatedReset({ duration: prefersReducedMotion() ? 0 : 400 });
  }, []);

  function changeMode(next: ColorMode) {
    setMode(next);
    setHighlight(null);
  }

  function zoom(action: "in" | "out" | "reset") {
    const camera = sigmaRef.current?.getCamera();
    const duration = prefersReducedMotion() ? 0 : 300;
    if (action === "in") {
      camera?.animatedZoom({ duration });
    } else if (action === "out") {
      camera?.animatedUnzoom({ duration });
    } else {
      camera?.animatedReset({ duration });
    }
  }

  const legend = useMemo(() => {
    if (mode === "type") {
      const counts = new Map<WikiPageType, number>();
      for (const node of data.nodes) {
        counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
      }
      return WIKI_PAGE_TYPES.filter((type) => counts.has(type)).map((type) => ({
        key: `type:${type}`,
        label: t(`wiki.types.${type}`),
        count: counts.get(type) ?? 0,
      }));
    }
    return [...data.communities]
      .sort((a, b) => b.size - a.size || a.id - b.id)
      .map((community) => ({
        key: `community:${community.id}`,
        label: community.label,
        count: community.size,
      }));
  }, [mode, data, t]);

  const activeNode = active ? nodesBySlug.get(active) : undefined;
  const titleOf = (slug: string) => nodesBySlug.get(slug)?.title ?? slug;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section
        aria-labelledby="wiki-graph-title"
        className="flex min-h-[75vh] min-w-0 flex-1 flex-col lg:min-h-0"
      >
        <div className="space-y-3 border-b px-4 py-3">
          <GraphHeading>
            <GraphSearch nodesBySlug={nodesBySlug} onSelect={focusNode} />
          </GraphHeading>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <fieldset className="flex items-center gap-2">
              <legend className="sr-only">{t("wiki.graph.colorBy")}</legend>
              <span aria-hidden className="text-xs font-medium text-muted-foreground uppercase">
                {t("wiki.graph.colorBy")}
              </span>
              <div className="inline-flex rounded-md border p-0.5">
                {(["type", "community"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mode === value}
                    onClick={() => changeMode(value)}
                    className={cn(
                      "rounded px-2.5 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring",
                      mode === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {value === "type" ? t("wiki.graph.byType") : t("wiki.graph.byCommunity")}
                  </button>
                ))}
              </div>
            </fieldset>
            <ul aria-label={t("wiki.graph.legend")} className="flex flex-wrap gap-1.5">
              {legend.map((entry) => {
                const pressed = highlight === entry.key;
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => setHighlight(pressed ? null : entry.key)}
                      className={cn(
                        "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
                        "hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring",
                        pressed && "border-ring bg-accent text-accent-foreground",
                        highlight && !pressed && "opacity-60",
                      )}
                    >
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: paletteVar(colorIndex.get(entry.key) ?? -1) }}
                      />
                      <span className="truncate">{entry.label}</span>
                      <span className="text-muted-foreground tabular-nums">{entry.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="relative min-h-80 flex-1 overflow-hidden">
          {renderFailed ? (
            <div className="p-4">
              <ErrorAlert>{t("wiki.graph.renderError")}</ErrorAlert>
            </div>
          ) : (
            <div
              ref={containerRef}
              role="img"
              aria-label={t("wiki.graph.canvasLabel", {
                nodes: data.nodes.length,
                edges: data.edges.length,
              })}
              className="absolute inset-0"
            />
          )}

          {layoutRunning ? (
            <output className="absolute top-3 left-3 inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              {t("wiki.graph.arranging")}
            </output>
          ) : null}

          <div className="absolute top-3 right-3 flex flex-col gap-1 rounded-md border bg-card p-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("wiki.graph.zoomIn")}
              onClick={() => zoom("in")}
            >
              <ZoomIn aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("wiki.graph.zoomOut")}
              onClick={() => zoom("out")}
            >
              <ZoomOut aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("wiki.graph.resetView")}
              onClick={() => zoom("reset")}
            >
              <Maximize aria-hidden />
            </Button>
          </div>

          {activeNode ? (
            <div
              className={cn(
                "absolute bottom-3 left-3 w-72 max-w-[calc(100%-1.5rem)] space-y-2 rounded-md border bg-card p-3 text-sm shadow-sm",
                !selected && "pointer-events-none",
              )}
            >
              <div className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-1.5 size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: paletteVar(
                      colorIndex.get(
                        groupKey(mode, {
                          pageType: activeNode.type,
                          community: activeNode.community,
                        }),
                      ) ?? -1,
                    ),
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{activeNode.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      t(`wiki.types.${activeNode.type}`),
                      communitiesById.get(activeNode.community)?.label,
                      t("wiki.graph.degree", { count: activeNode.degree }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {selected ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-mt-1 -mr-1 size-7"
                    aria-label={t("wiki.graph.clearSelection")}
                    onClick={() => setSelected(null)}
                  >
                    <X aria-hidden />
                  </Button>
                ) : null}
              </div>
              {neighborWeights.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase">
                    {t("wiki.graph.strongestConnections")}
                  </p>
                  <ul className="space-y-0.5">
                    {neighborWeights.slice(0, NEIGHBOR_LIMIT).map((neighbor) => (
                      <li key={neighbor.slug} className="flex items-center justify-between gap-2">
                        {selected ? (
                          <button
                            type="button"
                            onClick={() => focusNode(neighbor.slug)}
                            className="min-w-0 truncate text-left text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {titleOf(neighbor.slug)}
                          </button>
                        ) : (
                          <span className="min-w-0 truncate">{titleOf(neighbor.slug)}</span>
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {t("wiki.graph.weight", { weight: formatNumber(neighbor.weight, 1) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {neighborWeights.length > NEIGHBOR_LIMIT ? (
                    <p className="text-xs text-muted-foreground">
                      {t("wiki.graph.moreConnections", {
                        count: neighborWeights.length - NEIGHBOR_LIMIT,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("wiki.graph.noConnections")}</p>
              )}
              {selected ? (
                <Link to={`${base}/${activeNode.slug}`} className={buttonClasses("outline", "sm")}>
                  <ExternalLink aria-hidden />
                  {t("wiki.graph.openPage")}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <InsightsPanel
        data={data}
        titleOf={titleOf}
        onFocusNode={focusNode}
        onFocusCommunity={focusCommunity}
      />
    </div>
  );
}

// --- Search --------------------------------------------------------------------------------

function GraphSearch({
  nodesBySlug,
  onSelect,
}: {
  nodesBySlug: ReadonlyMap<string, { slug: string; title: string }>;
  onSelect: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const { overview } = useWiki();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) {
      return [];
    }
    return overview.pages
      .filter((page) => nodesBySlug.has(page.slug))
      .filter((page) => normalize(page.title).includes(needle) || page.slug.includes(needle))
      .slice(0, SEARCH_LIMIT);
  }, [query, overview.pages, nodesBySlug]);

  const expanded = open && query.trim().length > 0;

  function choose(slug: string) {
    onSelect(slug);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (matches.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + matches.length) % matches.length);
      }
    } else if (event.key === "Enter") {
      const match = matches[activeIndex] ?? matches[0];
      if (match) {
        event.preventDefault();
        choose(match.slug);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative w-full sm:w-64">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <label htmlFor={`${id}-input`} className="sr-only">
        {t("wiki.graph.searchLabel")}
      </label>
      <Input
        id={`${id}-input`}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          expanded && matches[activeIndex] ? `${id}-${activeIndex}` : undefined
        }
        className="h-9 pl-9"
        placeholder={t("wiki.graph.searchPlaceholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {expanded ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={t("wiki.graph.searchLabel")}
          className="absolute top-full right-0 left-0 z-10 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("wiki.graph.noMatches")}</p>
          ) : (
            matches.map((page, index) => (
              <div
                key={page.slug}
                id={`${id}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                // Keep focus in the input so the click lands before blur closes the list.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(page.slug)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    choose(page.slug);
                  }
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "cursor-pointer rounded px-2 py-1.5 text-sm",
                  index === activeIndex && "bg-accent text-accent-foreground",
                )}
              >
                <span className="block truncate">{page.title}</span>
                {page.section ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {page.section}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- Insights ------------------------------------------------------------------------------

function InsightSection({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint?: string;
  count: number;
  children: (limit: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const headingId = useId();
  const limit = showAll ? count : LIST_LIMIT;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div>
        <h4
          id={headingId}
          className="flex items-center justify-between gap-2 text-sm font-semibold"
        >
          {title}
          <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
        </h4>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{t("wiki.graph.insights.none")}</p>
      ) : (
        children(limit)
      )}
      {count > LIST_LIMIT ? (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? t("wiki.graph.insights.showLess")
            : t("wiki.graph.insights.showMore", { count: count - LIST_LIMIT })}
        </Button>
      ) : null}
    </section>
  );
}

const entryButton =
  "min-w-0 truncate rounded-sm text-left text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring";

function InsightsPanel({
  data,
  titleOf,
  onFocusNode,
  onFocusCommunity,
}: {
  data: WikiGraphData;
  titleOf: (slug: string) => string;
  onFocusNode: (slug: string) => void;
  onFocusCommunity: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { insights } = data;
  const communities = new Map(data.communities.map((community) => [community.id, community]));
  const sparse = insights.sparseCommunities
    .map((id) => communities.get(id))
    .filter((community) => community !== undefined);

  return (
    <aside
      aria-labelledby="wiki-graph-insights"
      className="space-y-5 border-t p-4 lg:w-80 lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l"
    >
      <h3 id="wiki-graph-insights" className="font-semibold">
        {t("wiki.graph.insights.title")}
      </h3>

      <InsightSection
        title={t("wiki.graph.insights.surprising")}
        hint={t("wiki.graph.insights.surprisingHint")}
        count={insights.surprising.length}
      >
        {(limit) => (
          <ul className="space-y-2">
            {insights.surprising.slice(0, limit).map((item) => (
              <li
                key={`${item.source}|${item.target}`}
                className="space-y-1 rounded-md border bg-card p-2"
              >
                <div className="flex items-center gap-1.5 text-sm">
                  <button
                    type="button"
                    className={entryButton}
                    onClick={() => onFocusNode(item.source)}
                  >
                    {titleOf(item.source)}
                  </button>
                  <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="sr-only">{t("wiki.graph.insights.connectedTo")}</span>
                  <button
                    type="button"
                    className={entryButton}
                    onClick={() => onFocusNode(item.target)}
                  >
                    {titleOf(item.target)}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {item.reasons.map((reason: WikiSurpriseReason) => (
                    <Badge key={reason} variant="primary">
                      {t(`wiki.graph.reasons.${reason}`)}
                    </Badge>
                  ))}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("wiki.graph.insights.score", { score: formatNumber(item.score) })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        title={t("wiki.graph.insights.bridges")}
        hint={t("wiki.graph.insights.bridgesHint")}
        count={insights.bridges.length}
      >
        {(limit) => (
          <ul className="space-y-1">
            {insights.bridges.slice(0, limit).map((bridge) => (
              <li key={bridge.slug} className="flex items-center justify-between gap-2 text-sm">
                <button
                  type="button"
                  className={entryButton}
                  onClick={() => onFocusNode(bridge.slug)}
                >
                  {titleOf(bridge.slug)}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("wiki.graph.insights.bridgeCommunities", { count: bridge.communities })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        title={t("wiki.graph.insights.isolated")}
        hint={t("wiki.graph.insights.isolatedHint")}
        count={insights.isolated.length}
      >
        {(limit) => (
          <ul className="space-y-1">
            {insights.isolated.slice(0, limit).map((slug) => (
              <li key={slug} className="flex text-sm">
                <button type="button" className={entryButton} onClick={() => onFocusNode(slug)}>
                  {titleOf(slug)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>

      <InsightSection
        title={t("wiki.graph.insights.sparse")}
        hint={t("wiki.graph.insights.sparseHint")}
        count={sparse.length}
      >
        {(limit) => (
          <ul className="space-y-1">
            {sparse.slice(0, limit).map((community) => (
              <li key={community.id} className="space-y-0.5 text-sm">
                <button
                  type="button"
                  className={cn(entryButton, "block max-w-full")}
                  onClick={() => onFocusCommunity(community.id)}
                >
                  {community.label}
                </button>
                <p className="text-xs text-muted-foreground">
                  {t("wiki.graph.insights.communitySize", { count: community.size })} ·{" "}
                  {t("wiki.graph.insights.cohesion", { value: formatPercent(community.cohesion) })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </InsightSection>
    </aside>
  );
}
