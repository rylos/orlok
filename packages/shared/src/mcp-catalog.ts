import type { McpToolPolicy, McpTransport } from "./ops";

// Catalog of ready-made external tools (R-OPS-15): an administrator picks one, fills in the
// credentials and the office has a new tool, without building images or editing files.

// One value the administrator fills in: an HTTP header (remote servers) or an environment
// variable (local commands). All of them are stored encrypted; only secret ones are masked.
// Labels and hints are in the translations of the web app, under the entry's id.
export type McpCatalogField = {
  name: string;
  optional?: boolean;
  // A password or a key: typed masked, and never shown again once saved.
  secret?: boolean;
  default?: string;
  placeholder?: string;
};

// What people read about an entry (description, how to set it up, why its policy) lives in the
// translations of the web app, under ops.mcp.catalog.entries.<id>: here only what makes it work.
export type McpCatalogEntry = {
  id: McpCatalogId;
  // A product name, the same in every language.
  name: string;
  category: "database" | "infrastructure" | "office" | "other";
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  fields: McpCatalogField[];
  toolPolicy: McpToolPolicy;
  // The only tools colleagues are given; absent for all of them.
  tools?: string[];
  documentationUrl?: string;
  // A service the customer runs next to Orlok, which the tool then talks to.
  needsService?: boolean;
  // Local commands that fetch their package the first time they run: they need internet access
  // from the runner and start more slowly after a restart.
  downloadsOnFirstRun?: boolean;
};

export const MCP_CATALOG_IDS = [
  "dbhub",
  "mariadb-official",
  "aws",
  "proxmox",
  "custom-http",
] as const;
export type McpCatalogId = (typeof MCP_CATALOG_IDS)[number];

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "dbhub",
    name: "Databases (DBHub)",
    category: "database",
    transport: "http",
    fields: [],
    toolPolicy: "readonly_auto",
    documentationUrl: "https://github.com/bytebase/dbhub",
    needsService: true,
  },
  {
    id: "mariadb-official",
    name: "MariaDB (official server)",
    category: "database",
    transport: "http",
    fields: [],
    toolPolicy: "readonly_auto",
    documentationUrl: "https://github.com/mariadb/mcp",
    needsService: true,
  },
  {
    id: "aws",
    name: "AWS",
    category: "infrastructure",
    transport: "stdio",
    command: "uvx",
    // Frankfurt: the AWS MCP Server runs there and in N. Virginia only. The region the scripts
    // work in is the one filled in below.
    args: ["mcp-proxy-for-aws@1.6.4", "https://aws-mcp.eu-central-1.api.aws/mcp"],
    fields: [
      {
        name: "AWS_ACCESS_KEY_ID",
        placeholder: "AKIA…",
      },
      {
        name: "AWS_SECRET_ACCESS_KEY",
        secret: true,
      },
      {
        name: "AWS_REGION",
        placeholder: "eu-south-1",
      },
    ],
    toolPolicy: "readonly_auto",
    documentationUrl:
      "https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html",
    downloadsOnFirstRun: true,
  },
  {
    id: "proxmox",
    name: "Proxmox VE",
    category: "infrastructure",
    transport: "stdio",
    command: "uvx",
    args: ["--from", "proxmox-mcp-server==1.4.2", "proxmox-mcp-server"],
    fields: [
      {
        name: "PROXMOX_HOST",
        placeholder: "10.0.1.10",
      },
      {
        name: "PROXMOX_PORT",
        default: "8006",
        optional: true,
      },
      {
        name: "PROXMOX_USER",
        placeholder: "orlok@pve",
      },
      {
        name: "PROXMOX_TOKEN_NAME",
        placeholder: "mcp",
      },
      {
        name: "PROXMOX_TOKEN_VALUE",
        secret: true,
      },
      {
        name: "PROXMOX_VERIFY_SSL",
        default: "0",
        optional: true,
      },
    ],
    toolPolicy: "ask_all",
    // The server offers 286 tools. One call to any API path covers them all, and the cluster
    // overview comes ready-made; the rest would fill every prompt with descriptions.
    tools: ["proxmox_api_raw", "get_cluster_status", "get_cluster_resources", "get_cluster_tasks"],
    documentationUrl: "https://pypi.org/project/proxmox-mcp-server/",
    downloadsOnFirstRun: true,
  },
  {
    id: "custom-http",
    name: "Remote server (custom)",
    category: "other",
    transport: "http",
    fields: [
      {
        name: "Authorization",
        optional: true,
        secret: true,
      },
    ],
    toolPolicy: "readonly_auto",
    documentationUrl: "https://modelcontextprotocol.io/docs/concepts/transports",
  },
];

export function findCatalogEntry(id: string) {
  return MCP_CATALOG.find((entry) => entry.id === id) ?? null;
}
