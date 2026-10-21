// R-OPS-4: built-in command rules for the classifier. Two lists shared by both shells:
// READ_ONLY_RULES are diagnostics that inspect state without changing it or revealing secrets;
// DENY_RULES are the small, uncontroversial set of catastrophic patterns that are always refused.
// Everything destructive that is not listed here simply asks for approval.

import type { CommandRule, ShellKind } from "@orlok/shared";

// A rule matches when its program glob matches the program (or its basename) and, if an
// argPattern is given, the whole argument string (args joined by single spaces) matches it.
// PowerShell program matching is case-insensitive; POSIX is case-sensitive. argPatterns are
// always case-insensitive because flag case rarely matters for the decision.
export function ruleMatches(
  rule: CommandRule,
  program: string,
  args: string[],
  shell: ShellKind,
): boolean {
  if (rule.shell !== "any" && rule.shell !== shell) return false;
  const caseInsensitive = shell === "powershell";
  if (!programMatches(rule.program, program, caseInsensitive)) return false;
  if (rule.argPattern === undefined) return true;
  const re = new RegExp(`^(?:${rule.argPattern})$`, "i");
  return re.test(args.join(" "));
}

function programMatches(glob: string, program: string, caseInsensitive: boolean): boolean {
  const re = globToRegExp(glob, caseInsensitive);
  if (re.test(program)) return true;
  // Also match on the basename so an absolute path like /bin/rm matches a bare `rm` rule.
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  if (slash >= 0) return re.test(program.slice(slash + 1));
  return false;
}

function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, caseInsensitive ? "i" : "");
}

const r = (
  id: string,
  shell: ShellKind | "any",
  program: string,
  description: string,
  argPattern?: string,
): CommandRule => ({ id, shell, program, description, ...(argPattern ? { argPattern } : {}) });

// --- Read-only allowlist --------------------------------------------------------------------

const POSIX_READ_ONLY: CommandRule[] = [
  // Network diagnostics.
  r(
    "ping",
    "posix",
    "ping",
    "ICMP echo with a bounded count",
    // Require a count of at most 20 and forbid flood mode.
    "(?!.*(?:^|\\s)-f(?:\\s|$))(?=.*(?:^|\\s)-c\\s*(?:[1-9]|1[0-9]|20)(?:\\s|$)).*",
  ),
  r("dig", "posix", "dig", "DNS lookup"),
  r("nslookup", "posix", "nslookup", "DNS lookup"),
  r("host", "posix", "host", "DNS lookup"),
  r("traceroute", "posix", "traceroute", "Trace the route to a host"),
  r("tracepath", "posix", "tracepath", "Trace the route to a host"),
  r("mtr", "posix", "mtr", "Trace with a single report", "(?=.*--report).*"),
  r(
    "nc",
    "posix",
    "nc",
    "TCP port probe",
    "(?!.*(?:^|\\s)-[ec](?:\\s|$))(?=.*(?:^|\\s)-z(?:\\s|$))(?=.*(?:^|\\s)-w\\s*\\d+(?:\\s|$)).*",
  ),
  r("ssh-keyscan", "posix", "ssh-keyscan", "Fetch a host's public SSH key"),
  // System inspection.
  r("uptime", "posix", "uptime", "Show uptime and load"),
  r("uname", "posix", "uname", "Show kernel info"),
  r("hostname", "posix", "hostname", "Show the hostname"),
  r("whoami", "posix", "whoami", "Show the current user"),
  r("id", "posix", "id", "Show user and group ids"),
  r("date", "posix", "date", "Show the date and time"),
  r("df", "posix", "df", "Show free disk space"),
  r("du", "posix", "du", "Show disk usage"),
  r("free", "posix", "free", "Show memory usage"),
  r("lsblk", "posix", "lsblk", "List block devices"),
  r("lscpu", "posix", "lscpu", "Show CPU info"),
  r("lsusb", "posix", "lsusb", "List USB devices"),
  r("lspci", "posix", "lspci", "List PCI devices"),
  r("ss", "posix", "ss", "Show sockets"),
  r("netstat", "posix", "netstat", "Show network connections"),
  r("ps", "posix", "ps", "List processes"),
  r("top", "posix", "top", "One-shot process snapshot", "(?=.*-b)(?=.*-n\\s*\\d+).*"),
  r(
    "ip",
    "posix",
    "ip",
    "Show network configuration",
    // Only show/list objects; never add/del/set/flush/change/replace.
    "(?!.*(?:^|\\s)(?:add|del|delete|set|flush|change|replace|append|monitor)(?:\\s|$))(?=.*(?:^|\\s)(?:addr|address|a|route|r|link|l|neigh|n|maddr|rule)(?:\\s|$)).*",
  ),
  r(
    "systemctl",
    "posix",
    "systemctl",
    "Read service state",
    "(?!.*(?:^|\\s)(?:start|stop|restart|reload|try-restart|enable|disable|mask|unmask|kill|isolate|set-property|set-default|edit|daemon-reload|reset-failed)(?:\\s|$))(?=.*(?:^|\\s)(?:status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-sockets|list-timers|list-dependencies|show|cat|get-default|show-environment)(?:\\s|$)).*",
  ),
  r(
    "journalctl",
    "posix",
    "journalctl",
    "Read logs without a pager",
    "(?=.*--no-pager)(?=.*(?:(?:^|\\s)-n(?:\\s|$)|(?:^|\\s)-n\\s*\\d+|--lines|--since|--until)).*",
  ),
  r(
    "docker",
    "posix",
    "docker",
    "Inspect containers and images",
    "(?:ps|images|version|info|top|port|history|inspect|events)(?:\\s.*)?|logs(?:\\s.*)?|image\\s+ls(?:\\s.*)?|stats\\s+.*--no-stream.*",
  ),
  // Proxmox and storage read commands.
  r("pvesh", "posix", "pvesh", "Read Proxmox API", "get\\s+.*"),
  r("qm", "posix", "qm", "Read VM state", "(?:list|status|config)(?:\\s.*)?"),
  r("pct", "posix", "pct", "Read container state", "(?:list|status|config)(?:\\s.*)?"),
  r("zpool", "posix", "zpool", "Read ZFS pool state", "(?:status|list|iostat|get)(?:\\s.*)?"),
  r("zfs", "posix", "zfs", "Read ZFS datasets", "(?:list|get)(?:\\s.*)?"),
  r(
    "smartctl",
    "posix",
    "smartctl",
    "Read SMART data",
    "(?!.*(?:^|\\s)(?:-t|--test|--set)(?:\\s|=|$)).*(?:^|\\s)-(?:a|H|x|i|A|c|l)\\b.*",
  ),
  // File inspection (sensitive paths are still filtered by the classifier).
  r("cat", "posix", "cat", "Print a file"),
  r("tac", "posix", "tac", "Print a file reversed"),
  r("head", "posix", "head", "Print the start of a file"),
  r("tail", "posix", "tail", "Print the end of a file"),
  r("less", "posix", "less", "Page a file"),
  r("more", "posix", "more", "Page a file"),
  r("nl", "posix", "nl", "Number lines"),
  r("grep", "posix", "grep", "Search text"),
  r("egrep", "posix", "egrep", "Search text"),
  r("fgrep", "posix", "fgrep", "Search text"),
  r("zgrep", "posix", "zgrep", "Search compressed text"),
  r("wc", "posix", "wc", "Count lines and words"),
  r("ls", "posix", "ls", "List files"),
  r("stat", "posix", "stat", "Show file metadata"),
  r("file", "posix", "file", "Guess a file type"),
  r("readlink", "posix", "readlink", "Resolve a symlink"),
  r("realpath", "posix", "realpath", "Resolve a path"),
  r("basename", "posix", "basename", "Strip a path"),
  r("dirname", "posix", "dirname", "Directory of a path"),
  r("sort", "posix", "sort", "Sort lines"),
  r("uniq", "posix", "uniq", "Filter duplicate lines"),
  r("cut", "posix", "cut", "Select columns"),
  r("tr", "posix", "tr", "Translate characters"),
  r("column", "posix", "column", "Columnate lists"),
  r("od", "posix", "od", "Octal dump"),
  r("xxd", "posix", "xxd", "Hex dump"),
  r("hexdump", "posix", "hexdump", "Hex dump"),
  r("strings", "posix", "strings", "Print printable strings"),
  // curl is read-only only for HEAD/GET without upload or file output; the classifier checks.
  r("curl", "posix", "curl", "HTTP HEAD or GET request"),
  r("jq", "posix", "jq", "Query JSON"),
  r("yq", "posix", "yq", "Query YAML"),
  // find/awk/sed are read-only only for the safe subset; the classifier vets their arguments.
  r("find", "posix", "find", "Search the filesystem"),
  r("awk", "posix", "awk", "Process text"),
  r("gawk", "posix", "gawk", "Process text"),
  r("sed", "posix", "sed", "Stream editor in print mode"),
  // TLS / certificate inspection.
  r(
    "openssl",
    "posix",
    "openssl",
    "Inspect TLS and certificates",
    "s_client\\s+.*-connect.*|x509\\s+.*-noout.*|verify\\s+.*|dgst\\s+.*|rand\\s+.*",
  ),
  // Repository state and history (the read-only forms of OpenCode's former Plan mode), without
  // writing a file (--output) or running an external diff program.
  r(
    "git",
    "posix",
    "git",
    "Read repository state",
    "(?!.*(?:--output|--ext-diff))(?:(?:-C\\s+\\S+|--no-pager)\\s+)*(?:status|log|diff|show)(?:\\s.*)?",
  ),
];

const POWERSHELL_READ_ONLY: CommandRule[] = [
  // Every Get-* cmdlet reads state; Get-Credential and Get-Content on secrets are vetted by
  // the classifier.
  r("ps-get", "powershell", "Get-*", "Read state with a Get cmdlet"),
  r("ps-test-netconnection", "powershell", "Test-NetConnection", "Probe a network endpoint"),
  r("ps-test-connection", "powershell", "Test-Connection", "Ping a host"),
  r("ps-test-path", "powershell", "Test-Path", "Test whether a path exists"),
  r("ps-resolve-dnsname", "powershell", "Resolve-DnsName", "DNS lookup"),
  r("ps-select-object", "powershell", "Select-Object", "Select properties"),
  r("ps-where-object", "powershell", "Where-Object", "Filter objects"),
  r("ps-sort-object", "powershell", "Sort-Object", "Sort objects"),
  r("ps-group-object", "powershell", "Group-Object", "Group objects"),
  r("ps-measure-object", "powershell", "Measure-Object", "Aggregate objects"),
  r("ps-compare-object", "powershell", "Compare-Object", "Compare objects"),
  r("ps-foreach-object", "powershell", "ForEach-Object", "Iterate objects"),
  r("ps-format-table", "powershell", "Format-Table", "Format as a table"),
  r("ps-format-list", "powershell", "Format-List", "Format as a list"),
  r("ps-format-wide", "powershell", "Format-Wide", "Format wide"),
  r("ps-out-string", "powershell", "Out-String", "Render to a string"),
  r("ps-out-host", "powershell", "Out-Host", "Render to the host"),
  r("ps-write-output", "powershell", "Write-Output", "Write to the pipeline"),
  r("ps-write-host", "powershell", "Write-Host", "Write to the host"),
  r("ps-out-null", "powershell", "Out-Null", "Discard the output"),
  r("ps-start-sleep", "powershell", "Start-Sleep", "Wait"),
  r("ps-join-path", "powershell", "Join-Path", "Join a path"),
  r("ps-split-path", "powershell", "Split-Path", "Split a path"),
  r("ps-select-string", "powershell", "Select-String", "Search text"),
  r("ps-convertto-json", "powershell", "ConvertTo-Json", "Serialize to JSON"),
  r("ps-convertto-csv", "powershell", "ConvertTo-Csv", "Serialize to CSV"),
  r("ps-convertfrom-json", "powershell", "ConvertFrom-Json", "Parse JSON"),
  r("ps-measure-command", "powershell", "Measure-Command", "Time a read-only block"),
  // Legacy Windows diagnostics.
  r("ps-ipconfig", "powershell", "ipconfig", "Show IP configuration"),
  r("ps-ping", "powershell", "ping", "Ping a host", "(?=.*(?:^|\\s)-n\\s*\\d+(?:\\s|$)).*"),
  r("ps-nslookup", "powershell", "nslookup", "DNS lookup"),
  r("ps-tracert", "powershell", "tracert", "Trace a route"),
  r("ps-whoami", "powershell", "whoami", "Show the current user"),
  r("ps-hostname", "powershell", "hostname", "Show the hostname"),
  r("ps-systeminfo", "powershell", "systeminfo", "Show system info"),
  r("ps-netstat", "powershell", "netstat", "Show network connections"),
  r("ps-tasklist", "powershell", "tasklist", "List processes"),
  // `sc.exe query`: a bare `sc` is Set-Content in Windows PowerShell (resolvePsName).
  r("ps-sc", "powershell", "sc", "Query services", "query(?:\\s.*)?|queryex(?:\\s.*)?"),
  r("ps-wmic", "powershell", "wmic", "Read WMI data", ".*(?:^|\\s)get(?:\\s|$).*|.*\\blist\\b.*"),
  r(
    "ps-repadmin",
    "powershell",
    "repadmin",
    "AD replication status",
    "/(?:showrepl|replsummary|showconn|queue)(?:\\s.*)?",
  ),
  r("ps-dcdiag", "powershell", "dcdiag", "Domain controller diagnostics"),
  r("ps-gpresult", "powershell", "gpresult", "Group policy result", "/r(?:\\s.*)?|/z(?:\\s.*)?"),
  r(
    "ps-nltest",
    "powershell",
    "nltest",
    "Read domain trust info",
    "/(?:sc_query|dsgetdc|dclist|query).*",
  ),
];

export const READ_ONLY_RULES: CommandRule[] = [...POSIX_READ_ONLY, ...POWERSHELL_READ_ONLY];

// --- Deny list ------------------------------------------------------------------------------
// Kept intentionally small: only patterns that are catastrophic in every context. Structural
// catastrophes that no program/arg rule can express (fork bombs, writing to a raw device) are
// handled directly in the classifier.

const POSIX_DENY: CommandRule[] = [
  r(
    "deny-rm-root",
    "posix",
    "rm",
    "Recursive delete of the filesystem root",
    // rm with a recursive+force flag targeting / or /* or --no-preserve-root.
    ".*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\\s+-f|-f\\s+-r).*(?:(?:^|\\s)(?:/|/\\*)(?:\\s|$))|.*--no-preserve-root.*",
  ),
  r("deny-mkfs", "posix", "mkfs*", "Create a filesystem (wipes the target)"),
  r("deny-wipefs", "posix", "wipefs", "Erase filesystem signatures"),
  r("deny-dd-dev", "posix", "dd", "Write with dd to a device", ".*(?:^|\\s)of=/dev/.*"),
  r("deny-shred-dev", "posix", "shred", "Shred a device", ".*(?:^|\\s)/dev/.*"),
  r(
    "deny-chmod-root",
    "posix",
    "chmod",
    "Recursive chmod of the root",
    ".*(?:^|\\s)-[a-zA-Z]*R[a-zA-Z]*(?:\\s|$).*(?:^|\\s)/(?:\\s|$).*|.*-R\\s+777\\s+/(?:\\s|$).*",
  ),
  r(
    "deny-chown-root",
    "posix",
    "chown",
    "Recursive chown of the root",
    ".*(?:^|\\s)-[a-zA-Z]*R[a-zA-Z]*(?:\\s|$).*(?:^|\\s)/(?:\\s|$).*",
  ),
];

const POWERSHELL_DENY: CommandRule[] = [
  r("deny-format-volume", "powershell", "Format-Volume", "Format a volume"),
  r("deny-clear-disk", "powershell", "Clear-Disk", "Wipe a disk"),
  r("deny-diskpart", "powershell", "diskpart", "Scriptable disk partitioning"),
  r("deny-bcdedit-delete", "powershell", "bcdedit", "Delete a boot entry", ".*/delete.*"),
  r("deny-cipher-wipe", "powershell", "cipher", "Wipe free space", ".*/w.*"),
  r(
    "deny-vssadmin-delete",
    "powershell",
    "vssadmin",
    "Delete shadow copies",
    ".*delete\\s+shadows.*",
  ),
  r(
    "deny-wevtutil-clear",
    "powershell",
    "wevtutil",
    "Clear event logs (audit tampering)",
    "(?:cl|clear-log)\\s+.*",
  ),
  r(
    "deny-remove-item-root",
    "powershell",
    "Remove-Item",
    "Recursive delete of a drive root",
    "(?=.*-Recurse).*(?:^|\\s)[A-Za-z]:\\\\?(?:\\s|$).*",
  ),
  r("deny-remove-addomain", "powershell", "Remove-ADDomain", "Remove an AD domain"),
  r("deny-remove-adforest", "powershell", "Remove-ADForest", "Remove an AD forest"),
];

export const DENY_RULES: CommandRule[] = [...POSIX_DENY, ...POWERSHELL_DENY];
