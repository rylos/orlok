// Checks on wiki content that need no model (R-MEM-7): literal values are compared
// as they are written.

const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const HOST = "[a-z][a-z0-9-]{2,30}";
// Only unambiguous forms: "host: ip", "host = ip", "host → ip". Not "host (ip)": in "CT 100 on
// app03 (10.0.0.30)" the address belongs to the container. Not "user@ip": that is a user.
const HOST_IP = new RegExp(
  String.raw`(?<![\w.@-])\x60?(${HOST})\x60?\s*(?::|=|→|->)\s*\x60?(${IPV4})\b(?![.:/\d])`,
  "gi",
);
const ONLY_IP = new RegExp(`^${IPV4}$`);
const PRIVATE_IP = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./;
// Words written before an address that are not host names.
const NOT_HOSTS = new Set(
  (
    "ip lan wan gateway host hostname server ssh dns router default via porta port ping from to " +
    "dhcp subnet netmask mask gw nat dnat snat address addr indirizzo inet src dst dest target " +
    "listen bind proxy ext int vpn tailscale route rotta interfaccia interface vlan bridge macvlan " +
    "peer endpoint allowed nameserver http https tcp udp url web api sito client cliente utente " +
    "user admin root rete network ipv4 locale remoto ex vecchio nuovo old new prima dopo test " +
    "prova esempio example lo la il da su con per e ed che interno esterno pubblico privato " +
    "ipaddr ntpserver nic tunnel administrator"
  ).split(" "),
);

export type LintPage = { slug: string; title: string; content: string };

// Host → private address pairs written in each page: table rows with the name in the first cell
// and a single address, and the forms above. Public addresses change with the lines, and are left
// out.
export function hostAddresses(pages: LintPage[]) {
  const pairs = new Map<string, { host: string; ip: string; slugs: Set<string> }>();
  const add = (host: string, ip: string, slug: string) => {
    const name = host.toLowerCase();
    if (NOT_HOSTS.has(name) || !PRIVATE_IP.test(ip)) {
      return;
    }
    const key = `${name} ${ip}`;
    const pair = pairs.get(key) ?? { host: name, ip, slugs: new Set<string>() };
    pair.slugs.add(slug);
    pairs.set(key, pair);
  };
  for (const page of pages) {
    for (const line of page.content.split("\n")) {
      if (line.trimStart().startsWith("|")) {
        const cells = line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.replace(/[\s`*]/g, ""));
        const ips = cells.filter((cell) => ONLY_IP.test(cell));
        const name = (cells[0] ?? "").toLowerCase();
        if (ips.length === 1 && new RegExp(`^${HOST}$`).test(name) && ips[0]) {
          add(name, ips[0], page.slug);
        }
        continue;
      }
      for (const match of line.matchAll(HOST_IP)) {
        if (match[1] && match[2]) {
          add(match[1], match[2], page.slug);
        }
      }
    }
  }
  return [...pairs.values()];
}

export type AddressConflict = { host: string; addresses: { ip: string; slugs: string[] }[] };

// Hosts given two different addresses in the same /24 by different pages: one of them is probably
// out of date.
export function addressConflicts(pages: LintPage[]): AddressConflict[] {
  const byHost = new Map<string, Map<string, Set<string>>>();
  for (const { host, ip, slugs } of hostAddresses(pages)) {
    const addresses = byHost.get(host) ?? new Map<string, Set<string>>();
    addresses.set(ip, new Set([...(addresses.get(ip) ?? []), ...slugs]));
    byHost.set(host, addresses);
  }
  const conflicts: AddressConflict[] = [];
  for (const [host, addresses] of byHost) {
    const byNetwork = new Map<string, string[]>();
    for (const ip of addresses.keys()) {
      const network = ip.slice(0, ip.lastIndexOf("."));
      byNetwork.set(network, [...(byNetwork.get(network) ?? []), ip]);
    }
    for (const ips of byNetwork.values()) {
      const slugs = new Set(ips.flatMap((ip) => [...(addresses.get(ip) ?? [])]));
      if (ips.length > 1 && slugs.size > 1) {
        conflicts.push({
          host,
          addresses: ips.sort().map((ip) => ({ ip, slugs: [...(addresses.get(ip) ?? [])].sort() })),
        });
      }
    }
  }
  return conflicts.sort((x, y) => x.host.localeCompare(y.host));
}

// Words that only mean something on the day they were written. "Oggi" and "today" are left out:
// on a real company wiki they were mostly column headings and templates ("Oggi | Domani").
const RELATIVE =
  /\b(ieri|l'altro ieri|attualmente|di recente|recentemente|la settimana scorsa|il mese scorso|yesterday|currently|recently|last week|last month|nowadays)\b/i;
const ABSOLUTE_DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b|\b(19|20)\d{2}\b/i;

// Lines that say "currently", "yesterday" and the like without a date: true when written, and
// impossible to date later (after mem0). Code blocks are left out.
export function relativeDateLines(content: string, limit = 3) {
  const found: string[] = [];
  let inCode = false;
  for (const line of content.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !RELATIVE.test(line) || ABSOLUTE_DATE.test(line)) {
      continue;
    }
    const text = line.replace(/\s+/g, " ").trim();
    found.push(text.length > 160 ? `${text.slice(0, 159)}…` : text);
    if (found.length === limit) {
      break;
    }
  }
  return found;
}

export const VERIFICATION_MAX_DAYS = 365;

// A check against the real systems older than a year says little about today.
export function isStaleVerification(verifiedOn: string | null, today: Date) {
  if (!verifiedOn) {
    return false;
  }
  const days = (today.getTime() - Date.parse(`${verifiedOn}T00:00:00Z`)) / 86_400_000;
  return days > VERIFICATION_MAX_DAYS;
}

// Hosts with a known address mentioned in at least `minPages` pages, none of which is about them
// (no title names them): a page of their own is probably missing.
export function hostsWithoutPage(pages: LintPage[], minPages = 4) {
  const hosts = new Set(hostAddresses(pages).map((pair) => pair.host));
  const found: { host: string; slugs: string[] }[] = [];
  for (const host of [...hosts].sort()) {
    // Host names are letters, digits and hyphens: nothing to escape.
    const word = new RegExp(`(?<![\\w-])${host}(?![\\w-])`, "i");
    if (pages.some((page) => word.test(page.title) || word.test(page.slug))) {
      continue;
    }
    const slugs = pages.filter((page) => word.test(page.content)).map((page) => page.slug);
    if (slugs.length >= minPages) {
      found.push({ host, slugs });
    }
  }
  return found.sort((x, y) => y.slugs.length - x.slugs.length);
}
