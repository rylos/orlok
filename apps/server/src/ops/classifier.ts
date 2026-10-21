// R-OPS-4: the command classifier. Virtual colleagues propose shell commands; this decides
// whether a command runs immediately (allow), needs a human (ask) or is refused (deny). This is
// the security boundary, so parsing is done with a real shell parser (unbash for POSIX) and a
// careful hand-written reader for PowerShell scripts, and anything that cannot be fully analyzed
// asks rather than allows.
//
// Since 2026-10-05 a command line is split into pieces, each with its type
// (command-types.ts). In ask mode the line runs when every piece is read-only or of a type the
// person approved "always"; otherwise it asks for the missing types only. A line that cannot be
// read to the end (`$(...)`, `bash -c`, a script…) has nothing to remember, so it asks once.

import type {
  CommandClassification,
  CommandDecision,
  CommandRule,
  ExecMode,
  ShellKind,
} from "@orlok/shared";
import {
  type Command as BashCommand,
  type Node as BashNode,
  type ParsedScript,
  parse,
  type Redirect,
  type Statement,
  type Word,
  type WordPart,
} from "unbash";
import { commandType, typeKey, WRITE_TYPE } from "./command-types.js";
import { DENY_RULES, READ_ONLY_RULES, ruleMatches } from "./rules.js";

// --- Public API -----------------------------------------------------------------------------

// A single command found in the command line, reduced to a program name and its dequoted args.
type SimpleCommand = {
  program: string;
  args: string[];
  // Per argument: a fixed literal, with no variable, substitution or glob.
  fixed: boolean[];
};

// A piece of the line that gets a type of its own: a simple command, with sudo or doas folded
// into its type, or a file written with `>`.
type Piece = SimpleCommand & {
  prefix?: string;
  // Why this piece may run only once, never "always" (a sensitive file, a secret).
  onceOnly?: string;
};

// The result of statically analysing a command line for one shell.
type Analysis = {
  // Every simple command found, in source order, wrappers such as sudo and timeout included:
  // deny rules look at all of them.
  commands: SimpleCommand[];
  // What the line does, piece by piece, each judged on its own.
  pieces: Piece[];
  // The first reason the line cannot be read to the end (null when it can): it then asks, and
  // only once. Ordering follows the source.
  opaque: string | null;
  // A structural pattern that is catastrophic regardless of mode (fork bomb, write to a raw
  // device). When set, the command is denied even in full mode.
  denyReason: string | null;
  // A script that only computes and prints values, with no command in it: `"Total: " + 2`.
  valuesOnly?: boolean;
};

// The types one person approved "always" (typeKey()s), and those an administrator disabled:
// a disabled type asks once and cannot be approved "always" again.
export type TypeApprovals = { approved: ReadonlySet<string>; blocked: ReadonlySet<string> };

const NO_APPROVALS: TypeApprovals = { approved: new Set(), blocked: new Set() };

export function classifyCommand(
  command: string,
  shell: ShellKind,
  options: { mode: ExecMode; approvals?: TypeApprovals; denyRules?: CommandRule[] },
): CommandClassification {
  const { mode } = options;
  const approvals = options.approvals ?? NO_APPROVALS;
  const denyRules = [...DENY_RULES, ...(options.denyRules ?? [])];

  if (mode === "deny") {
    return {
      decision: "deny",
      reason: "Commands are disabled for this colleague",
      matchedRules: [],
      programs: [],
    };
  }

  const analysis = shell === "powershell" ? analyzePowershell(command) : analyzePosix(command);
  const programs = analysis.commands.map((c) => c.program);

  // Yolo is the one mode that lets destructive commands through: an administrator chose it,
  // knowing it (decided 2026-10-05).
  if (mode === "yolo") {
    return decision("allow", "Approvals and blocks are disabled for this colleague", [], programs);
  }

  // Deny rules and structural catastrophes win in every other mode, including full.
  if (analysis.denyReason) {
    return decision("deny", analysis.denyReason, [], programs);
  }
  for (const cmd of analysis.commands) {
    const matched = denyRules.find((rule) => ruleMatches(rule, cmd.program, cmd.args, shell));
    if (matched) {
      return decision(
        "deny",
        `\`${cmd.program}\` matches a forbidden pattern (${matched.description})`,
        [matched.id],
        programs,
      );
    }
  }

  if (mode === "full") {
    return decision("allow", "Approvals are disabled for this colleague", [], programs);
  }

  // ask mode: a line that cannot be read to the end asks, once.
  if (analysis.opaque) {
    return decision("ask", analysis.opaque, [], programs, { types: [], onceOnly: true });
  }
  if (analysis.pieces.length === 0) {
    if (analysis.valuesOnly)
      return decision("allow", "Only computes and prints values", [], programs);
    return decision("ask", "No command to classify", [], programs, { types: [], onceOnly: true });
  }
  const matchedIds: string[] = [];
  const missing: string[] = [];
  let onceReason: string | null = null;
  // Why a read-only program is not read-only this time (`sed -i`), to tell people.
  let objection: string | null = null;
  for (const piece of analysis.pieces) {
    // Reading a key or a password file asks every time, "always" or not.
    const sensitive = readsFiles(piece) ? piece.args.find(isSensitivePath) : undefined;
    const once = piece.onceOnly ?? (sensitive ? `reads a sensitive path (\`${sensitive}\`)` : null);
    if (once) {
      onceReason ??= once;
      continue;
    }
    const readOnly = readOnlyRule(piece, shell);
    if (readOnly) {
      matchedIds.push(readOnly);
      continue;
    }
    const type =
      piece.program === WRITE_TYPE
        ? WRITE_TYPE
        : commandType(
            shell,
            shell === "posix" ? basename(piece.program) : piece.program,
            wordsOf(piece),
            piece.prefix,
          );
    if (type === null) {
      onceReason ??= `the type of \`${piece.program}\` depends on a variable`;
      continue;
    }
    const key = typeKey(shell, type);
    if (approvals.blocked.has(key)) {
      onceReason ??= `\`${type}\` was disabled by an administrator`;
    } else if (approvals.approved.has(key)) {
      matchedIds.push(`type:${type}`);
      continue;
    }
    if (!missing.some((known) => typeKey(shell, known) === key)) {
      missing.push(type);
    }
    objection ??= piece.prefix ? null : readOnlyObjection(piece, shell);
  }
  if (onceReason) {
    return decision("ask", onceReason, matchedIds, programs, { types: missing, onceOnly: true });
  }
  if (missing.length > 0) {
    const list = missing.map((type) => `\`${type}\``).join(", ");
    const reason = `${list} ${missing.length === 1 ? "needs" : "need"} approval${objection ? ` (${objection})` : ""}`;
    return decision("ask", reason, matchedIds, programs, { types: missing, onceOnly: false });
  }
  return decision(
    "allow",
    "Every command is read-only or of an approved type",
    matchedIds,
    programs,
  );
}

function decision(
  d: CommandDecision,
  reason: string,
  matchedRules: string[],
  programs: string[],
  approval?: { types: string[]; onceOnly: boolean },
): CommandClassification {
  return { decision: d, reason, matchedRules, programs, ...approval };
}

// The read-only rule a piece matches, when it passes the per-program checks too. A piece run
// through sudo is never read-only: elevation is a type of its own.
function readOnlyRule(piece: Piece, shell: ShellKind): string | null {
  if (piece.prefix || piece.program === WRITE_TYPE) return null;
  const rule = READ_ONLY_RULES.find((rl) => ruleMatches(rl, piece.program, piece.args, shell));
  if (!rule || readOnlyObjection(piece, shell)) return null;
  return rule.id;
}

function wordsOf(cmd: SimpleCommand) {
  return cmd.args.map((value, index) => ({ value, fixed: cmd.fixed[index] ?? false }));
}

// --- Shared program sets --------------------------------------------------------------------

// Interpreters run arbitrary code from an argument, a file or stdin: what they do cannot be
// read, so they ask every time, never "always". Both shells; compared in lower case.
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "ash",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "python",
  "python2",
  "python3",
  "py",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "perl5",
  "ruby",
  "php",
  "lua",
  "luajit",
  "tclsh",
  "expect",
  "rscript",
  "irb",
  "ghci",
  "pwsh",
  "powershell",
  "cmd",
  "wsl",
  "wscript",
  "cscript",
  "mshta",
]);

function isInterpreter(program: string): boolean {
  const base = basename(program)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return INTERPRETERS.has(base) || /^(?:python|perl|ruby|php|node|lua)[\d.]+$/.test(base);
}

// Programs that run a command on another machine: the remote command is not read here.
const REMOTE_SHELLS = new Set(["ssh"]);

// A script run by path: what it does is in a file.
function scriptReason(program: string, shell: ShellKind): string | null {
  const script =
    shell === "powershell"
      ? /^\.{1,2}[\\/]|\.(?:ps1|psm1|bat|cmd|vbs|js|wsf)$/i.test(program)
      : /^\.{1,2}\/|\.(?:sh|bash|zsh|py|pl|rb|php|js)$/.test(program);
  return script ? `runs the script \`${program}\`` : null;
}

// Wrappers run another command. sudo and doas change the privileges: they are part of the type
// (`sudo systemctl restart`). The transparent ones change nothing that matters for approval, so
// the type is the wrapped command's. The others (su -c, xargs, env with variables…) run something
// that is not read here: they ask once. Every wrapped command is still extracted so deny rules
// can see it.
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas"]);
const TRANSPARENT_WRAPPERS = new Set(["timeout", "nice", "ionice", "nohup", "time", "stdbuf"]);
const OPAQUE_WRAPPERS = new Set([
  "su",
  "runuser",
  "env",
  "watch",
  "xargs",
  "setsid",
  "chroot",
  "unshare",
  "flock",
  // Not wrappers in name, but each runs whatever command it is given: "always" on them would
  // approve anything that goes through them.
  "command",
  "builtin",
  "trap",
  "pkexec",
  "nsenter",
  "systemd-run",
  "parallel",
  "script",
  "sshpass",
  "at",
  "batch",
  "tmux",
  "screen",
  "strace",
  "ltrace",
  "gdb",
  "chrt",
  "taskset",
  "cgexec",
  "firejail",
]);

// The same on Windows: they start another program, as another user or on another machine.
const PS_RUNNERS = new Set(["runas", "psexec", "psexec64", "paexec"]);

// Shell builtins that evaluate or source code.
const EVAL_BUILTINS = new Set(["eval", "exec", "source", "."]);

// Environment variables that change how the next program loads code or resolves.
const DANGEROUS_ENV = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "IFS",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PS4",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
  "PERL5LIB",
  "GLOBIGNORE",
]);

// Programs whose file arguments are read: a sensitive path turns allow into ask.
const FILE_READERS = new Set([
  "cat",
  "tac",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "wc",
  "ls",
  "stat",
  "file",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "awk",
  "gawk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "readlink",
  "realpath",
]);

// --- POSIX analysis (unbash) ----------------------------------------------------------------

function analyzePosix(command: string): Analysis {
  const commands: SimpleCommand[] = [];
  const pieces: Piece[] = [];
  const state = { opaque: null as string | null, deny: null as string | null };
  const setOpaque = (reason: string) => {
    if (state.opaque === null) state.opaque = reason;
  };
  const setDeny = (reason: string) => {
    if (state.deny === null) state.deny = reason;
  };
  const addWrite = (target: Word | undefined) => {
    pieces.push({
      program: WRITE_TYPE,
      args: [target?.value ?? ""],
      fixed: [target ? !programFromExpansion(target) : false],
    });
  };

  let script: ParsedScript;
  try {
    script = parse(command);
  } catch {
    return { commands, pieces, opaque: "The command could not be parsed", denyReason: null };
  }
  if (script.errors && script.errors.length > 0) {
    setOpaque("The command could not be fully parsed");
  }

  // Scan a word for structures that hide execution (command/process substitution).
  const scanWord = (word: Word | undefined) => {
    for (const part of collectParts(word)) {
      if (part.type === "CommandExpansion") setOpaque("uses command substitution");
      else if (part.type === "ProcessSubstitution") setOpaque("uses process substitution");
      else if (part.type === "ArithmeticExpansion") {
        // Arithmetic can itself embed $(); a plain $((1+1)) is harmless.
        if (part.text.includes("$(") || /`/.test(part.text)) setOpaque("uses command substitution");
      }
    }
  };

  // One simple command, unwrapping sudo, timeout and the like. `prefix` is the privilege
  // wrapper found around it so far.
  const handleSimple = (cmd: SimpleCommand, prefix?: string) => {
    commands.push(cmd);
    const base = basename(cmd.program);
    if (EVAL_BUILTINS.has(base)) return setOpaque(`uses \`${base}\``);
    if (isInterpreter(base)) return setOpaque(`runs the interpreter \`${base}\``);
    if (REMOTE_SHELLS.has(base)) return setOpaque(`\`${base}\` runs a command on another machine`);
    const script = scriptReason(cmd.program, "posix");
    if (script) return setOpaque(script);
    const code = runsCode(cmd);
    if (code) return setOpaque(code);
    if (
      PRIVILEGE_WRAPPERS.has(base) ||
      TRANSPARENT_WRAPPERS.has(base) ||
      OPAQUE_WRAPPERS.has(base)
    ) {
      const inner = unwrap(base, cmd);
      if (inner === "dynamic") return setOpaque("the program name comes from an expansion");
      if (inner === null) {
        // `sudo -l`, `env`: the wrapper alone, a piece like any other.
        pieces.push(prefix ? { ...cmd, prefix } : cmd);
        return;
      }
      if (OPAQUE_WRAPPERS.has(base)) {
        commands.push(inner);
        return setOpaque(`\`${base}\` runs another command`);
      }
      const wrapped = PRIVILEGE_WRAPPERS.has(base) ? (prefix ? `${prefix} ${base}` : base) : prefix;
      return handleSimple(inner, wrapped);
    }
    pieces.push(prefix ? { ...cmd, prefix } : cmd);
  };

  const handleCommand = (cmd: BashCommand) => {
    // Assignments that change how the next program loads code.
    for (const assign of cmd.prefix) {
      if (assign.name && DANGEROUS_ENV.has(assign.name)) {
        setOpaque(`sets \`${assign.name}\` before the command`);
      }
      scanWord(assign.value);
    }
    handleProgram(cmd);
    // Redirections: writing to a normal file is a piece of its own; to a raw device, denied.
    for (const redir of cmd.redirects) analyzeRedirect(redir, addWrite, setDeny);
  };

  const handleProgram = (cmd: BashCommand) => {
    if (!cmd.name) {
      // Assignment-only or redirect-only command: not read-only on its own.
      if (cmd.prefix.length > 0) setOpaque("sets a shell variable");
      return;
    }
    scanWord(cmd.name);
    for (const suffix of cmd.suffix) scanWord(suffix);

    // A program name that comes from an expansion or glob cannot be analysed.
    if (programFromExpansion(cmd.name)) {
      setOpaque("the program name comes from an expansion");
      return;
    }
    handleSimple({
      program: cmd.name.value,
      args: cmd.suffix.map((w) => w.value),
      fixed: cmd.suffix.map((w) => !programFromExpansion(w)),
    });
  };

  const walkNode = (node: BashNode) => {
    switch (node.type) {
      case "Command":
        handleCommand(node);
        break;
      case "Pipeline":
      case "AndOr":
        for (const child of node.commands) walkNode(child);
        break;
      case "Statement":
        walkStatement(node);
        break;
      case "Subshell":
      case "BraceGroup":
        for (const stmt of node.body.commands) walkStatement(stmt);
        break;
      case "CompoundList":
        for (const stmt of node.commands) walkStatement(stmt);
        break;
      case "If":
        for (const stmt of node.clause.commands) walkStatement(stmt);
        for (const stmt of node.then.commands) walkStatement(stmt);
        if (node.else) walkNode(node.else);
        break;
      case "For":
        for (const w of node.wordlist) scanWord(w);
        for (const stmt of node.body.commands) walkStatement(stmt);
        break;
      case "While":
        for (const stmt of node.clause.commands) walkStatement(stmt);
        for (const stmt of node.body.commands) walkStatement(stmt);
        break;
      case "Select":
        setOpaque("uses an interactive `select`");
        for (const stmt of node.body.commands) walkStatement(stmt);
        break;
      case "Case":
        scanWord(node.word);
        for (const item of node.items) for (const stmt of item.body.commands) walkStatement(stmt);
        break;
      case "ArithmeticFor":
        for (const stmt of node.body.commands) walkStatement(stmt);
        break;
      case "Function":
        setOpaque("defines a function");
        break;
      case "Coproc":
        setOpaque("starts a coprocess");
        break;
      case "TestCommand":
        // `[ ]` / `[[ ]]` are read-only tests; still scan for hidden substitutions.
        scanTestWords(node, scanWord);
        break;
      case "ArithmeticCommand":
        if (node.body.includes("$(") || /`/.test(node.body)) setOpaque("uses command substitution");
        break;
      default:
        setOpaque("uses an unsupported shell construct");
    }
  };

  function walkStatement(stmt: Statement) {
    if (stmt.background) setOpaque("runs in the background with `&`");
    for (const redir of stmt.redirects) analyzeRedirect(redir, addWrite, setDeny);
    walkNode(stmt.command);
  }

  // Classic fork bomb: a function that pipes itself into itself in the background.
  if (isForkBomb(command)) setDeny("fork bomb");

  for (const stmt of script.commands) walkStatement(stmt);

  return { commands, pieces, opaque: state.opaque, denyReason: state.deny };
}

function analyzeRedirect(
  redir: Redirect,
  addWrite: (target: Word | undefined) => void,
  setDeny: (r: string) => void,
) {
  const op = redir.operator;
  // Reading from a file is fine.
  if (op === "<" || op === "<<" || op === "<<-" || op === "<<<" || op === "<>") return;
  // Duplicating a file descriptor (2>&1, >&2) is fine; redirecting to a non-fd target is a write.
  if (op === ">&" || op === "<&") {
    const target = redir.target?.value ?? "";
    if (/^\d+-?$/.test(target)) return;
  }
  if (op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>" || op === ">&") {
    const target = redir.target?.value ?? "";
    if (target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr") return;
    if (/^\/dev\/(?:sd|nvme|vd|hd|mmcblk|disk|xvd|drbd|md)/.test(target)) {
      setDeny("writes to a raw block device");
      return;
    }
    addWrite(redir.target);
  }
}

function collectParts(word: Word | undefined): WordPart[] {
  if (!word?.parts) return [];
  const out: WordPart[] = [];
  const visit = (parts: WordPart[] | undefined) => {
    if (!parts) return;
    for (const part of parts) {
      out.push(part);
      // Double-quoted strings nest expansions.
      if (part.type === "DoubleQuoted") visit(part.parts as unknown as WordPart[]);
    }
  };
  visit(word.parts);
  return out;
}

// A program name is only safe when it reduces to a fixed literal (possibly quoted). Any
// expansion, substitution or glob in program position is unanalysable.
function programFromExpansion(name: Word): boolean {
  for (const part of collectParts(name)) {
    if (
      part.type === "SimpleExpansion" ||
      part.type === "ParameterExpansion" ||
      part.type === "CommandExpansion" ||
      part.type === "ArithmeticExpansion" ||
      part.type === "ProcessSubstitution" ||
      part.type === "BraceExpansion" ||
      part.type === "ExtendedGlob"
    ) {
      return true;
    }
    if (part.type === "DoubleQuoted") {
      for (const child of part.parts) {
        if (child.type !== "Literal") return true;
      }
    }
  }
  // A bare glob like `*` in program position: unbash keeps it literal with no parts.
  if (!name.parts && /[*?[]/.test(name.text)) return true;
  return false;
}

function scanTestWords(node: BashNode, scan: (w: Word | undefined) => void) {
  // Walk the test expression tree collecting operand words.
  const visit = (expr: unknown) => {
    if (!expr || typeof expr !== "object") return;
    const e = expr as Record<string, unknown>;
    if (e.operand && typeof (e.operand as Word).text === "string") scan(e.operand as Word);
    if (e.left) {
      if (typeof (e.left as Word).text === "string" && !(e.left as Record<string, unknown>).type)
        scan(e.left as Word);
      else if ((e.left as Word).text !== undefined && (e.left as Record<string, unknown>).operator)
        scan(e.left as Word);
      else visit(e.left);
    }
    if (e.right) {
      if (typeof (e.right as Word).text === "string" && !(e.right as Record<string, unknown>).type)
        scan(e.right as Word);
      else visit(e.right);
    }
    if (e.expression) visit(e.expression);
  };
  const tc = node as unknown as { expression?: unknown };
  visit(tc.expression);
}

// Strip a wrapper's own options to find the command it runs. "dynamic" when the name of that
// command is not fixed (`sudo $cmd`); null when there is none (`sudo -l`).
function unwrap(program: string, cmd: SimpleCommand): SimpleCommand | "dynamic" | null {
  const { args, fixed } = cmd;
  let i = 0;
  const valueOpts =
    program === "timeout"
      ? new Set(["-s", "-k", "--signal"])
      : program === "sudo"
        ? new Set(["-u", "-g", "-p", "-C", "-r", "-t", "-U"])
        : program === "xargs"
          ? new Set(["-I", "-a", "-d", "-E", "-L", "-n", "-P", "-s", "--replace"])
          : program === "nice" || program === "ionice"
            ? new Set(["-n", "-c"])
            : program === "stdbuf"
              ? new Set(["-i", "-o", "-e"])
              : new Set<string>();
  // env: skip VAR=value assignments.
  while (i < args.length) {
    const tok = args[i];
    if (tok === undefined) break;
    if (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      i++;
      if (valueOpts.has(tok) && i < args.length) i++;
      continue;
    }
    // timeout's first non-option argument is the duration.
    if (program === "timeout") {
      i++;
      break;
    }
    break;
  }
  const inner = args[i];
  if (!inner || inner.startsWith("-")) return null;
  if (!fixed[i]) return "dynamic";
  return { program: inner, args: args.slice(i + 1), fixed: fixed.slice(i + 1) };
}

// Programs that read, but run commands when their arguments say so: then the line cannot be
// read to the end. Their other non-read uses (`find -delete`, `sed -i`) have a type like any
// other command.
function runsCode(cmd: SimpleCommand): string | null {
  const base = basename(cmd.program);
  if (base === "find") {
    const exec = cmd.args.find((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
    if (exec) return `\`find ${exec}\` runs another command`;
  }
  if (base === "awk" || base === "gawk") {
    if (
      cmd.args.some((a) =>
        /system\s*\(|\bprint\b[^)]*>|>>|\|\s*getline|\bgetline\b.*<|"\s*\|\s*"/.test(a),
      )
    ) {
      return "the awk program can run commands or write files";
    }
  }
  if (base === "sed") {
    if (cmd.args.some((a) => !a.startsWith("-") && /(?:^|;)\s*[wW]\s|\bw\s+\S|\be\b/.test(a))) {
      return "the sed script writes or runs a command";
    }
  }
  return null;
}

function isForkBomb(command: string): boolean {
  const compact = command.replace(/\s+/g, "");
  // e.g. :(){ :|:& };:  or  bomb(){ bomb|bomb& };bomb
  return (
    /([A-Za-z_.:][\w.:]*)\(\)\{.*\1\s*\|\s*\1.*&.*\}.*\1/.test(command) ||
    /:\(\)\{:\|:&\};:/.test(compact)
  );
}

// --- Per-program read-only checks (applied after an allow rule matched) ---------------------

// Programs whose file arguments are read. PowerShell names in any case: `get-content` is
// Get-Content.
function readsFiles(cmd: SimpleCommand): boolean {
  const base = basename(cmd.program);
  const lower = base.toLowerCase();
  return FILE_READERS.has(base) || lower === "get-content" || lower === "select-string";
}

function readOnlyObjection(cmd: SimpleCommand, shell: ShellKind): string | null {
  const { program, args } = cmd;
  const base = basename(program);
  if (readsFiles(cmd)) {
    const sensitive = args.find(isSensitivePath);
    if (sensitive) return `reads a sensitive path (\`${sensitive}\`)`;
  }
  if (shell === "posix") {
    if (base === "find") {
      const bad = args.find((a) =>
        ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(
          a,
        ),
      );
      if (bad) return `\`find ${bad}\` can run or delete`;
    }
    if (base === "awk" || base === "gawk") {
      if (
        args.some((a) =>
          /system\s*\(|\bprint\b[^)]*>|>>|\|\s*getline|\bgetline\b.*<|"\s*\|\s*"/.test(a),
        )
      ) {
        return "the awk program can run commands or write files";
      }
    }
    if (base === "sed") {
      if (args.some((a) => a === "-i" || a.startsWith("--in-place") || /^-i/.test(a))) {
        return "`sed -i` edits files in place";
      }
      if (args.some((a) => !a.startsWith("-") && /(?:^|;)\s*[wW]\s|\bw\s+\S|\be\b/.test(a))) {
        return "the sed script writes or runs a command";
      }
    }
    if (base === "curl") {
      const objection = curlObjection(args);
      if (objection) return objection;
    }
    if (base === "wget") {
      return "`wget` downloads to a file";
    }
  }
  return null;
}

function curlObjection(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "-X" || a === "--request") {
      const method = (args[i + 1] ?? "").toUpperCase();
      if (method !== "GET" && method !== "HEAD") return "curl uses a non-GET method";
    }
    if (a === "-d" || a === "--data" || a.startsWith("--data") || a === "-F" || a === "--form") {
      return "curl uploads request data";
    }
    if (a === "-T" || a === "--upload-file") return "curl uploads a file";
    if (a === "-K" || a === "--config") return "curl reads a config file";
    if (a === "-O" || a === "--remote-name") return "curl writes the response to a file";
    if (a === "-o" || a === "--output") {
      const dest = args[i + 1] ?? "";
      if (dest !== "/dev/null" && dest !== "-") return "curl writes the response to a file";
    }
    if (a.startsWith("-X")) {
      const method = a.slice(2).toUpperCase();
      if (method && method !== "GET" && method !== "HEAD") return "curl uses a non-GET method";
    }
  }
  return null;
}

function isSensitivePath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  const base = basename(arg);
  return (
    /\/etc\/(?:shadow|gshadow|sudoers)(?:$|\/)/.test(arg) ||
    /(?:^|\/)\.ssh(?:\/|$)/.test(arg) ||
    /\/root\/\.ssh/.test(arg) ||
    (/^id_(?:rsa|dsa|ecdsa|ed25519|[a-z0-9]+)$/.test(base) && !base.endsWith(".pub")) ||
    /\.pem$/.test(base) ||
    /\.key$/.test(base) ||
    /(?:^|\.)env$/.test(base) ||
    /\.aws\/credentials/.test(arg) ||
    /\.docker\/config\.json/.test(arg) ||
    /credentials?$/i.test(base) ||
    /\.htpasswd$/.test(base) ||
    /\.pgpass$/.test(base)
  );
}

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

// --- PowerShell analysis --------------------------------------------------------------------

// Common PowerShell aliases resolved to their cmdlet before matching.
const PS_ALIASES: Record<string, string> = {
  gci: "Get-ChildItem",
  ls: "Get-ChildItem",
  dir: "Get-ChildItem",
  gc: "Get-Content",
  cat: "Get-Content",
  type: "Get-Content",
  gi: "Get-Item",
  gp: "Get-ItemProperty",
  gpv: "Get-ItemPropertyValue",
  ps: "Get-Process",
  gps: "Get-Process",
  gsv: "Get-Service",
  select: "Select-Object",
  where: "Where-Object",
  "?": "Where-Object",
  foreach: "ForEach-Object",
  "%": "ForEach-Object",
  sort: "Sort-Object",
  group: "Group-Object",
  measure: "Measure-Object",
  ft: "Format-Table",
  fl: "Format-List",
  fw: "Format-Wide",
  gm: "Get-Member",
  gcm: "Get-Command",
  gv: "Get-Variable",
  echo: "Write-Output",
  write: "Write-Output",
  sls: "Select-String",
  oss: "Out-String",
  iex: "Invoke-Expression",
  icm: "Invoke-Command",
  saps: "Start-Process",
  gwmi: "Get-WmiObject",
  gcim: "Get-CimInstance",
  tee: "Tee-Object",
  // Windows PowerShell, which runs commands on Windows hosts: `sc.exe` is the service tool.
  sc: "Set-Content",
};

// Cmdlets that evaluate or launch code that is not read here: they ask once, never "always".
const PS_OPAQUE = new Set([
  "invoke-expression",
  "invoke-command",
  "invoke-item",
  "start-process",
  "start-job",
  // They change what a name runs later in the line, or load code: `Get-X` could be anything.
  "import-module",
  "ipmo",
  "new-alias",
  "set-alias",
  "nal",
  "sal",
]);

// Cmdlets whose script-block argument is analysed recursively.
const PS_BLOCK_HOSTS = new Set(["where-object", "foreach-object", "select-object"]);

// Since 2026-10-11 a PowerShell line is read as a script: statements, variables, expressions,
// if/foreach/try and the functions it defines. Every command found inside them is a piece like
// any other; what could still change something without being a command (a .NET method that is
// not on the lists below, a property set, a special variable) makes the line opaque.

// Keywords that start a statement of their own.
const PS_KEYWORDS = new Set([
  "if",
  "foreach",
  "for",
  "while",
  "do",
  "try",
  "exit",
  "return",
  "throw",
  "break",
  "continue",
  "function",
  "filter",
  "param",
  "begin",
  "process",
  "end",
]);

// Constructs not read here: they ask once.
const PS_UNREAD_KEYWORDS = new Set([
  "switch",
  "trap",
  "data",
  "class",
  "enum",
  "using",
  "workflow",
  "parallel",
  "sequence",
  "inlinescript",
  "configuration",
  "dynamicparam",
]);

// Variables that change how later commands run, or that PowerShell sets itself: assigning them
// is not a plain variable. Lower case, without `$`.
const PS_SPECIAL_VARIABLES = new Set([
  "psdefaultparametervalues",
  "executioncontext",
  "psmoduleautoloadingpreference",
  "psnativecommandargumentpassing",
  "psnativecommanduseerroractionpreference",
  "pssessionconfigurationname",
  "pssessionoption",
  "_",
  "psitem",
  "this",
  "input",
  "args",
  "true",
  "false",
  "host",
  "pscmdlet",
  "myinvocation",
  "psboundparameters",
  "pshome",
  "home",
  "profile",
  "shellid",
  "pid",
  "error",
  "matches",
  "stacktrace",
]);

// Scopes a variable may be read with: `$env:COMPUTERNAME`, `$script:total`. Another prefix is a
// provider path (`$function:x`, `${C:\file}`), which reads or writes something else.
const PS_READ_SCOPES = new Set(["env", "global", "script", "local", "private", "using"]);

// .NET types a script may convert to or read static values from, without `System.`, lower case.
const PS_SAFE_TYPES = new Set([
  "string",
  "char",
  "byte",
  "int",
  "int16",
  "int32",
  "int64",
  "long",
  "uint16",
  "uint32",
  "uint64",
  "double",
  "float",
  "single",
  "decimal",
  "bool",
  "boolean",
  "datetime",
  "timespan",
  "guid",
  "version",
  "array",
  "object",
  "hashtable",
  "ordered",
  "pscustomobject",
  "psobject",
  "xml",
  "void",
  "math",
  "convert",
  "regex",
  "uri",
  "environment",
  "io.path",
  "io.fileattributes",
  "io.searchoption",
  "net.ipaddress",
  "stringsplitoptions",
  "stringcomparison",
  "dayofweek",
]);

// Static methods that only compute a value, per type; `*` for every method of the type.
const PS_STATIC_METHODS: Record<string, ReadonlySet<string> | "*"> = {
  math: "*",
  char: "*",
  string: new Set([
    "join",
    "format",
    "concat",
    "compare",
    "equals",
    "isnullorempty",
    "isnullorwhitespace",
  ]),
  int: new Set(["parse"]),
  int32: new Set(["parse"]),
  int64: new Set(["parse"]),
  long: new Set(["parse"]),
  double: new Set(["parse"]),
  decimal: new Set(["parse"]),
  datetime: new Set([
    "parse",
    "parseexact",
    "compare",
    "daysinmonth",
    "isleapyear",
    "fromfiletime",
  ]),
  timespan: new Set([
    "fromdays",
    "fromhours",
    "fromminutes",
    "fromseconds",
    "frommilliseconds",
    "parse",
  ]),
  convert: new Set([
    "tostring",
    "toint32",
    "toint64",
    "todouble",
    "todecimal",
    "toboolean",
    "todatetime",
    "tobase64string",
    "frombase64string",
  ]),
  regex: new Set(["escape", "unescape", "ismatch", "match", "matches", "replace", "split"]),
  "io.path": new Set([
    "combine",
    "join",
    "getfilename",
    "getfilenamewithoutextension",
    "getextension",
    "getdirectoryname",
    "getfullpath",
    "getpathroot",
    "ispathrooted",
    "hasextension",
    "changeextension",
  ]),
  environment: new Set(["getenvironmentvariable", "getfolderpath", "getlogicaldrives"]),
  guid: new Set(["newguid", "parse"]),
  version: new Set(["parse"]),
  "net.ipaddress": new Set(["parse"]),
};

// Instance methods that only compute or read, whatever the object: text, dates, folder listings
// and in-memory collections. Any other method (`Kill`, `Delete`, `Stop`, `Add`, `Invoke`…) may
// change something, and the line is opaque.
const PS_SAFE_METHODS = new Set([
  "tostring",
  "gettype",
  "equals",
  "compareto",
  "gethashcode",
  "contains",
  "containskey",
  "containsvalue",
  "startswith",
  "endswith",
  "indexof",
  "lastindexof",
  "indexofany",
  "substring",
  "trim",
  "trimstart",
  "trimend",
  "toupper",
  "tolower",
  "toupperinvariant",
  "tolowerinvariant",
  "split",
  "replace",
  "padleft",
  "padright",
  "normalize",
  "adddays",
  "addhours",
  "addminutes",
  "addseconds",
  "addmilliseconds",
  "addmonths",
  "addyears",
  "addticks",
  "subtract",
  "touniversaltime",
  "tolocaltime",
  "toshortdatestring",
  "tolongdatestring",
  "toshorttimestring",
  "tolongtimestring",
  "getfiles",
  "getdirectories",
  "getfilesysteminfos",
  "enumeratefiles",
  "enumeratedirectories",
  "enumeratefilesysteminfos",
  "push",
  "pop",
  "peek",
  "enqueue",
  "dequeue",
  "toarray",
]);

type PsToken =
  | {
      kind: "word";
      text: string;
      value: string;
      hasSubexpr: boolean;
      isVariable: boolean;
      start: number;
      end: number;
    }
  | { kind: "block"; text: string; inner: string; start: number; end: number }
  | { kind: "op"; text: string; start: number; end: number }
  | { kind: "redirect"; write: boolean; start: number; end: number }
  | { kind: "invoke"; start: number; end: number };

// What the analysis of one PowerShell line collects as it goes.
type PsState = {
  commands: SimpleCommand[];
  pieces: Piece[];
  // The functions the script defines, in lower case: calling one runs its body, already read.
  functions: Set<string>;
  // Every word of the script, at every depth: a sensitive path may reach a reader through a
  // variable.
  literals: string[];
  // How deep in blocks and groups the analysis is: functions are read at the top only.
  depth: number;
  // Whether any statement was read at all.
  statements: number;
  setOpaque: (reason: string) => void;
};

const PS_PARSE_ERROR = "The command could not be parsed";
const PS_MAX_DEPTH = 40;

function analyzePowershell(command: string): Analysis {
  const state = { opaque: null as string | null };
  const ps: PsState = {
    commands: [],
    pieces: [],
    functions: new Set(),
    literals: [],
    depth: -1,
    statements: 0,
    setOpaque: (reason: string) => {
      if (state.opaque === null) state.opaque = reason;
    },
  };
  psStatements(command, ps);
  // `$p = 'C:\keys\id_rsa'; Get-Content $p`: the path is not an argument of the reader, but it
  // is in the script.
  const sensitive = ps.literals.find(isSensitivePath);
  if (sensitive) {
    for (const piece of ps.pieces) {
      if (readsFiles(piece)) piece.onceOnly ??= `reads a sensitive path (\`${sensitive}\`)`;
    }
  }
  return {
    commands: ps.commands,
    pieces: ps.pieces,
    opaque: state.opaque,
    denyReason: null,
    valuesOnly: ps.statements > 0 && ps.commands.length === 0,
  };
}

// A list of statements: a whole line, a block, the inside of `( )`, `$( )` or `@( )`.
function psStatements(src: string, ps: PsState) {
  if (ps.depth >= PS_MAX_DEPTH) return ps.setOpaque("nests too deeply");
  const tokens = tokenizePowershell(src);
  if (tokens === null) return ps.setOpaque(PS_PARSE_ERROR);
  for (const tok of tokens) if (tok.kind === "word") ps.literals.push(tok.value);
  ps.depth++;
  let i = 0;
  while (i < tokens.length) {
    if (isSeparator(tokens[i])) {
      i++;
      continue;
    }
    ps.statements++;
    i = psStatement(src, tokens, i, ps);
  }
  ps.depth--;
}

function isSeparator(tok: PsToken | undefined) {
  return tok?.kind === "op" && tok.text === ";";
}

function isPipe(tok: PsToken | undefined) {
  return tok?.kind === "op" && (tok.text === "|" || tok.text === "||" || tok.text === "&&");
}

// Where the statement that starts at `i` ends: at a separator, unless a pipe before it carries
// the pipeline on to the next line.
function statementEnd(tokens: PsToken[], i: number) {
  let j = i;
  while (j < tokens.length && !(isSeparator(tokens[j]) && !isPipe(tokens[j - 1]))) j++;
  return j;
}

// One statement starting at `i`; returns the index after it.
function psStatement(src: string, tokens: PsToken[], i: number, ps: PsState): number {
  const keyword = psKeyword(tokens[i]);
  if (keyword) {
    const next = psKeywordStatement(src, tokens, i, keyword, ps);
    if (next !== null) return next;
  }
  const end = statementEnd(tokens, i);
  const first = tokens[i];
  const last = tokens[end - 1];
  if (!first || !last) return end;
  const raw = src.slice(first.start, last.end);
  if (psAssignment(raw, ps)) return end;
  let segment: PsToken[] = [];
  let pipelineStart = true;
  for (let j = i; j <= end; j++) {
    const tok = tokens[j];
    if (j === end || isPipe(tok)) {
      if (segment.length > 0) psSegment(segment, pipelineStart, ps);
      segment = [];
      // `&&` and `||` start a new pipeline; after `|` comes a command.
      pipelineStart = tok?.kind === "op" && tok.text !== "|";
      continue;
    }
    if (tok && !isSeparator(tok)) segment.push(tok);
  }
  return end;
}

// The keyword a token starts with, and the `( )` glued to it (`foreach($f in $x)`).
function psKeyword(tok: PsToken | undefined): { name: string; glued: string } | null {
  if (tok?.kind !== "word") return null;
  const match = /^([A-Za-z]+)(\(.*)?$/s.exec(tok.text);
  const name = match?.[1]?.toLowerCase();
  if (!name || !(PS_KEYWORDS.has(name) || PS_UNREAD_KEYWORDS.has(name))) return null;
  return { name, glued: match?.[2] ?? "" };
}

// A statement that starts with a keyword; null when the word is a command after all
// (`foreach` with no `( )` is ForEach-Object).
function psKeywordStatement(
  src: string,
  tokens: PsToken[],
  start: number,
  keyword: { name: string; glued: string },
  ps: PsState,
): number | null {
  const { name } = keyword;
  let i = start + 1;
  // The `( )` after the keyword, glued or as the next word; its inside, or null.
  const paren = (glued: string): string | null => {
    let text = glued;
    if (!text) {
      const tok = tokens[i];
      if (tok?.kind !== "word" || !tok.text.startsWith("(")) return null;
      text = tok.text;
      i++;
    }
    if (matchDelimiter(text, 0, "(", ")") !== text.length - 1) return null;
    return text.slice(1, -1);
  };
  const skipSeparators = () => {
    while (isSeparator(tokens[i])) i++;
  };
  const block = (): boolean => {
    skipSeparators();
    const tok = tokens[i];
    if (tok?.kind !== "block") return false;
    psStatements(tok.inner, ps);
    i++;
    return true;
  };
  const unread = (reason: string) => {
    ps.setOpaque(reason);
    return statementEnd(tokens, start);
  };
  // The word after the end of a block: `else`, `catch`… possibly on the next line.
  const peekWord = (): string | null => {
    let j = i;
    while (isSeparator(tokens[j])) j++;
    const tok = tokens[j];
    return tok?.kind === "word" ? tok.text.toLowerCase() : null;
  };
  const takeWord = () => {
    skipSeparators();
    const tok = tokens[i];
    i++;
    return tok?.kind === "word" ? tok.text : "";
  };

  if (PS_UNREAD_KEYWORDS.has(name)) return unread(`uses \`${name}\``);
  switch (name) {
    case "if": {
      let cond = paren(keyword.glued);
      for (;;) {
        if (cond === null) return unread(PS_PARSE_ERROR);
        psStatements(cond, ps);
        if (!block()) return unread(PS_PARSE_ERROR);
        const next = peekWord();
        if (next?.startsWith("elseif")) {
          const glued = takeWord().slice("elseif".length);
          cond = paren(glued);
          continue;
        }
        if (next === "else") {
          takeWord();
          if (!block()) return unread(PS_PARSE_ERROR);
        }
        return i;
      }
    }
    case "foreach": {
      const open = tokens[i];
      if (!keyword.glued && !(open?.kind === "word" && open.text.startsWith("("))) return null;
      const inner = paren(keyword.glued);
      const loop = inner === null ? null : /^\s*\$([A-Za-z_]\w*)\s+in\s+([\s\S]+)$/i.exec(inner);
      if (!loop?.[1] || !loop[2]) return unread(PS_PARSE_ERROR);
      if (!psPlainVariable(loop[1], ps)) return statementEnd(tokens, start);
      psStatements(loop[2], ps);
      return block() ? i : unread(PS_PARSE_ERROR);
    }
    case "for":
    case "while": {
      const inner = paren(keyword.glued);
      if (inner === null) return unread(PS_PARSE_ERROR);
      psStatements(inner, ps);
      return block() ? i : unread(PS_PARSE_ERROR);
    }
    case "do": {
      if (!block()) return unread(PS_PARSE_ERROR);
      const word = takeWord();
      const loop = /^(while|until)(\(.*)?$/is.exec(word);
      const inner = loop ? paren(loop[2] ?? "") : null;
      if (inner === null) return unread(PS_PARSE_ERROR);
      psStatements(inner, ps);
      return i;
    }
    case "try": {
      if (!block()) return unread(PS_PARSE_ERROR);
      let handled = false;
      while (peekWord() === "catch") {
        takeWord();
        // The exception types it catches: `catch [System.Net.WebException], [IOException]`.
        skipSeparators();
        for (let tok = tokens[i]; tok?.kind === "word" && /^\[.*\],?$|^,$/s.test(tok.text); ) {
          i++;
          tok = tokens[i];
        }
        if (!block()) return unread(PS_PARSE_ERROR);
        handled = true;
      }
      if (peekWord() === "finally") {
        takeWord();
        if (!block()) return unread(PS_PARSE_ERROR);
        handled = true;
      }
      return handled ? i : unread(PS_PARSE_ERROR);
    }
    case "exit":
    case "return":
    case "throw": {
      const end = statementEnd(tokens, start);
      const from = tokens[start + 1];
      const to = tokens[end - 1];
      if (keyword.glued) psStatements(keyword.glued, ps);
      else if (from && to && end > start + 1) psStatements(src.slice(from.start, to.end), ps);
      return end;
    }
    case "break":
    case "continue":
      // What may follow is a loop label.
      return statementEnd(tokens, start);
    case "function":
    case "filter": {
      if (ps.depth > 0) return unread("defines a function inside a block");
      const word = takeWord();
      const header = /^([A-Za-z_][\w-]*)(\(.*)?$/s.exec(word);
      if (!header?.[1]) return unread(PS_PARSE_ERROR);
      // An alias wins over a function of the same name, and PowerShell's own aliases (`del`,
      // `kill`) have no dash: a function called without one might be something else.
      if (!header[1].includes("-")) return unread("defines a function whose name has no dash");
      // Added first, so that a call inside its own body is the function too.
      ps.functions.add(header[1].toLowerCase());
      const params = header[2] ? paren(header[2]) : tokens[i]?.kind === "word" ? paren("") : "";
      if (params === null) return unread(PS_PARSE_ERROR);
      if (params) psStatements(params, ps);
      return block() ? i : unread(PS_PARSE_ERROR);
    }
    case "param": {
      const inner = paren(keyword.glued);
      if (inner === null) return unread(PS_PARSE_ERROR);
      psStatements(inner, ps);
      return i;
    }
    case "begin":
    case "process":
    case "end":
      // The named blocks of a function body; otherwise a command name.
      if (keyword.glued || tokens[i]?.kind !== "block") return null;
      block();
      return i;
  }
  return null;
}

// `$x = …`, `[xml]$x = …`, `$n += 1`, `$i++`: true when the statement is an assignment, whose
// right side has then been read.
function psAssignment(raw: string, ps: PsState): boolean {
  const step = /^(?:\+\+|--)\$([A-Za-z_]\w*)\s*$|^\$([A-Za-z_]\w*)(?:\+\+|--)\s*$/.exec(raw);
  if (step) {
    psPlainVariable(step[1] ?? step[2] ?? "", ps);
    return true;
  }
  const assign =
    /^((?:\[[^\][]*(?:\[\])?\]\s*)*)\$(\{[^}]*\}|[A-Za-z_?][\w]*(?::[\w]+)?)((?:\.[A-Za-z_]\w*|\[[^\]]*\])*)\s*(?:[+\-*/%]|\?\?)?=(?!=)/.exec(
      raw,
    );
  if (!assign) return false;
  const [whole, casts = "", name = "", members = ""] = assign;
  if (members) {
    // `$file.IsReadOnly = $false` changes the file; `$h['k'] = 1` may change anything.
    ps.setOpaque("assigns a property");
  } else if (name.startsWith("{") || name.includes(":")) {
    ps.setOpaque(`sets \`$${name}\``);
  } else {
    psPlainVariable(name, ps);
  }
  for (const cast of casts.match(/\[[^\]]*(?:\[\])?\]/g) ?? []) psType(cast.slice(1, -1), ps);
  const value = raw.slice(whole.length);
  if (value.trim() === "") ps.setOpaque(PS_PARSE_ERROR);
  else psStatements(value, ps);
  return true;
}

// A variable a script may set: not one PowerShell reads to decide how commands run.
function psPlainVariable(name: string, ps: PsState): boolean {
  if (PS_SPECIAL_VARIABLES.has(name.toLowerCase())) {
    ps.setOpaque(`sets \`$${name}\``);
    return false;
  }
  return true;
}

// A piece of a pipeline: an expression at the start of one (`$d | Sort-Object`, `"Total: " + $n`),
// otherwise a command.
function psSegment(segment: PsToken[], pipelineStart: boolean, ps: PsState) {
  const head = segment[0];
  if (pipelineStart && head && psExpressionStart(head)) {
    psExpression(segment, ps);
    return;
  }
  psCommand(segment, ps);
}

// Whether a pipeline starting with this token is an expression, not a command: a variable, a
// string, a number, a group, a type, a unary operator. `7z` or `.\setup.ps1` are commands.
function psExpressionStart(tok: PsToken): boolean {
  if (tok.kind !== "word") return false;
  const text = tok.text;
  if (/^[$"'([@]/.test(text)) return true;
  // `-not`, `-1`: a command name never starts with a dash.
  if (/^-[A-Za-z\d.]/.test(text)) return true;
  // A number, then an operator or a range: `1GB`, `1..5`, `2*3`; `1.exe` is not one.
  return /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:[kmgtp]b|[ld])?(?:(?:\.\.|[-+*/%,]).*)?$/is.test(
    text,
  );
}

function psExpression(segment: PsToken[], ps: PsState) {
  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (!tok) continue;
    if (tok.kind === "invoke") ps.setOpaque("uses the call operator");
    else if (tok.kind === "block") psStatements(tok.inner, ps);
    else if (tok.kind === "redirect") {
      if (tok.write) {
        psWrite(segment[i + 1], ps);
        if (segment[i + 1]?.kind === "word") i++;
      }
    } else if (tok.kind === "word") psElement(tok.text, ps, true);
  }
}

function psCommand(group: PsToken[], ps: PsState) {
  // Leading invocation operator (& or .) means the target is evaluated dynamically.
  let idx = 0;
  const first = group[idx];
  if (first?.kind === "invoke") {
    ps.setOpaque("uses the call operator");
    idx++;
  }
  const head = group[idx];
  if (!head) return;
  if (head.kind === "redirect") {
    if (head.write) psWrite(group[idx + 1], ps);
    return;
  }
  if (head.kind === "block") {
    // A bare script block at command position; analyse its contents.
    psStatements(head.inner, ps);
    return;
  }
  if (head.kind !== "word") return;
  if (head.isVariable) {
    ps.setOpaque("the command name is a variable");
    return;
  }
  let name = head.value;
  const args: string[] = [];
  const fixed: boolean[] = [];
  const blocks: string[] = [];
  if (head.hasSubexpr) {
    // `Test-Path($p)`: a command with its first argument glued to it.
    const glued = /^([A-Za-z_][\w.-]*)(\(.*)$/s.exec(head.text);
    if (!glued?.[1] || !glued[2]) {
      ps.setOpaque("the command name is computed when it runs");
      return;
    }
    name = glued[1];
    psElement(glued[2], ps, false);
    args.push(glued[2].slice(1, -1));
    fixed.push(false);
  }

  const resolved = resolvePsName(name);
  const lower = resolved.toLowerCase();
  for (let i = idx + 1; i < group.length; i++) {
    const tok = group[i];
    if (tok === undefined) continue;
    if (tok.kind === "redirect") {
      if (tok.write) {
        psWrite(group[i + 1], ps);
        // The target of a redirection is not an argument of the command.
        if (group[i + 1]?.kind === "word") i++;
      }
      continue;
    }
    if (tok.kind === "invoke") {
      ps.setOpaque("uses the call operator");
      continue;
    }
    if (tok.kind === "block") {
      blocks.push(tok.inner);
      continue;
    }
    if (tok.kind === "word") {
      psElement(tok.text, ps, false);
      args.push(tok.value);
      fixed.push(psWordFixed(tok));
    }
  }

  const cmd = { program: resolved, args, fixed };
  ps.commands.push(cmd);

  // A function of the script: its body was read where it is defined.
  if (ps.functions.has(name.toLowerCase()) || ps.functions.has(lower)) {
    for (const block of blocks) psStatements(block, ps);
    return;
  }
  const script = scriptReason(name, "powershell");
  if (script) return ps.setOpaque(script);
  if (isInterpreter(resolved)) return ps.setOpaque(`runs the interpreter \`${resolved}\``);
  if (REMOTE_SHELLS.has(lower)) {
    return ps.setOpaque(`\`${resolved}\` runs a command on another machine`);
  }
  if (PS_OPAQUE.has(lower)) return ps.setOpaque(`\`${resolved}\` runs code`);
  if (PS_RUNNERS.has(lower)) return ps.setOpaque(`\`${resolved}\` runs another command`);
  // `ForEach-Object Stop` (or `-MemberName Stop`) calls that member on every object it gets:
  // the name alone does not say whether it reads a property or runs a method.
  if (lower === "foreach-object" && args.some((arg) => !arg.startsWith("-"))) {
    return ps.setOpaque("`ForEach-Object` calls a member by name");
  }
  if (blocks.length > 0) {
    if (!PS_BLOCK_HOSTS.has(lower)) {
      return ps.setOpaque(`\`${resolved}\` takes a script block that cannot be analysed`);
    }
    // The commands inside the block are pieces of the line like the others.
    for (const block of blocks) psStatements(block, ps);
  }
  if (lower === "get-credential") {
    ps.pieces.push({ ...cmd, onceOnly: "`Get-Credential` returns a secret" });
    return;
  }
  ps.pieces.push(cmd);
}

// A file written with `>`, a piece of its own; `> $null` throws the output away.
function psWrite(target: PsToken | undefined, ps: PsState) {
  if (target?.kind === "word" && target.value.toLowerCase() === "$null") return;
  const word = target?.kind === "word" ? target : null;
  ps.pieces.push({
    program: WRITE_TYPE,
    args: [word?.value ?? ""],
    fixed: [word ? psWordFixed(word) : false],
  });
}

// A word with nothing decided when the command runs: no variable, no sub-expression.
function psWordFixed(tok: { text: string; hasSubexpr: boolean; isVariable: boolean }): boolean {
  return !tok.isVariable && !tok.hasSubexpr && !/\$/.test(tok.text.replace(/'[^']*'/g, ""));
}

// One word of a statement, read character by character: the groups, sub-expressions, strings,
// hashtables and script blocks inside it are read as statements, members and types are checked.
// `expr` is set in an expression, where `=` can only be an assignment hidden inside it.
function psElement(text: string, ps: PsState, expr: boolean) {
  // What came just before: a value (`$x`, `)`, a name) makes `.Name(` a method and `[0]` an
  // index; otherwise `[int]` is a type.
  let afterValue = false;
  let i = 0;
  const n = text.length;
  const group = (open: number, openCh: string, closeCh: string): string | null => {
    const close = matchDelimiter(text, open, openCh, closeCh);
    if (close < 0) {
      ps.setOpaque(PS_PARSE_ERROR);
      return null;
    }
    i = close + 1;
    return text.slice(open + 1, close);
  };
  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "`") {
      i += 2;
      afterValue = true;
      continue;
    }
    if (ch === "'") {
      const quoted = readQuoted(text, i, "'");
      if (quoted === null) return ps.setOpaque(PS_PARSE_ERROR);
      i = quoted.end;
      afterValue = true;
      continue;
    }
    if (ch === '"') {
      const end = psExpandable(text, i, ps);
      if (end < 0) return ps.setOpaque(PS_PARSE_ERROR);
      i = end;
      afterValue = true;
      continue;
    }
    if (ch === "@" && (next === "'" || next === '"')) {
      // A here-string: @' … '@ or @" … "@.
      const close = text.indexOf(`${next}@`, i + 2);
      if (close < 0) return ps.setOpaque(PS_PARSE_ERROR);
      if (next === '"') {
        const body = text.slice(i + 2, close);
        for (let j = 0; j < body.length; ) j = body[j] === "`" ? j + 2 : psExpansion(body, j, ps);
      }
      i = close + 2;
      afterValue = true;
      continue;
    }
    if ((ch === "@" || ch === "$") && next === "(") {
      const inner = group(i + 1, "(", ")");
      if (inner === null) return;
      psStatements(inner, ps);
      afterValue = true;
      continue;
    }
    if (ch === "@" && next === "{") {
      const inner = group(i + 1, "{", "}");
      if (inner === null) return;
      psHashtable(inner, ps);
      afterValue = true;
      continue;
    }
    if (ch === "$") {
      i = psVariable(text, i, ps);
      afterValue = true;
      continue;
    }
    if (ch === "(") {
      const inner = group(i, "(", ")");
      if (inner === null) return;
      psStatements(inner, ps);
      afterValue = true;
      continue;
    }
    if (ch === "{") {
      const inner = group(i, "{", "}");
      if (inner === null) return;
      psStatements(inner, ps);
      afterValue = true;
      continue;
    }
    if (ch === "[") {
      const inner = group(i, "[", "]");
      if (inner === null) return;
      if (afterValue) {
        // An index: `$x[0]`, `$h['name']`.
        psStatements(inner, ps);
        continue;
      }
      const type = psTypeName(inner);
      if (text.startsWith("::", i)) {
        const member = /^::([A-Za-z_]\w*)/.exec(text.slice(i));
        if (!member?.[1]) return ps.setOpaque(PS_PARSE_ERROR);
        i += member[0].length;
        if (text[i] === "(") {
          const methods = PS_STATIC_METHODS[type];
          const name = member[1].toLowerCase();
          if (!(methods === "*" || methods?.has(name))) ps.setOpaque("calls a .NET method");
        } else {
          psType(inner, ps);
        }
        afterValue = true;
        continue;
      }
      // A conversion: `[int]$x`, `[xml](Get-Content …)`.
      psType(inner, ps);
      afterValue = false;
      continue;
    }
    if (ch === "." && afterValue) {
      if (next === ".") {
        // A range: `1..10`.
        i += 2;
        afterValue = false;
        continue;
      }
      const member = /^\.([A-Za-z_]\w*)/.exec(text.slice(i));
      if (member?.[1]) {
        i += member[0].length;
        // A generic method: `.Name[T](…)`.
        if (text[i] === "[") {
          const close = matchDelimiter(text, i, "[", "]");
          if (close > 0 && text[close + 1] === "(") i = close + 1;
        }
        if (text[i] === "(" && !PS_SAFE_METHODS.has(member[1].toLowerCase())) {
          ps.setOpaque("calls a .NET method");
        }
        continue;
      }
      if (next === "$" || next === "'" || next === '"' || next === "(") {
        ps.setOpaque("uses a member chosen when it runs");
      }
      i++;
      afterValue = false;
      continue;
    }
    if (ch === ":" && next === ":") {
      // `$type::Method()`: a type known only when it runs.
      if (afterValue) ps.setOpaque("uses a type chosen when it runs");
      i += 2;
      continue;
    }
    if (expr && ch === "=") ps.setOpaque("assigns a value");
    if (expr && (ch === "+" || ch === "-") && next === ch) ps.setOpaque("assigns a value");
    afterValue = /[\w]/.test(ch);
    i++;
  }
}

// A variable at `i` (after its `$`): its name may carry a scope. Returns the index after it.
function psVariable(text: string, i: number, ps: PsState): number {
  if (text[i + 1] === "{") {
    // `${C:\file.txt}` reads (or writes) the file; `${my var}` is a plain name.
    const close = text.indexOf("}", i + 2);
    if (close < 0) {
      ps.setOpaque(PS_PARSE_ERROR);
      return text.length;
    }
    if (text.slice(i + 2, close).includes(":")) ps.setOpaque("reads a path through a variable");
    return close + 1;
  }
  const match = /^\$(?:([A-Za-z_]\w*)(?::([A-Za-z_]\w*))?|[?^$_])/.exec(text.slice(i));
  if (!match) return i + 1;
  if (match[2] && !PS_READ_SCOPES.has((match[1] ?? "").toLowerCase())) {
    ps.setOpaque("reads a path through a variable");
  }
  return i + match[0].length;
}

// A double-quoted string starting at `start`: what `$( )` inside it runs is read. Returns the
// index after the closing quote, or -1.
function psExpandable(text: string, start: number, ps: PsState): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (text[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i = psExpansion(text, i, ps);
  }
  return -1;
}

// What a `$` at `i` expands to inside a string: a variable, or a sub-expression that is read.
// Returns the index after it.
function psExpansion(text: string, i: number, ps: PsState): number {
  if (text[i] !== "$") return i + 1;
  if (text[i + 1] === "(") {
    const close = matchDelimiter(text, i + 1, "(", ")");
    if (close < 0) {
      ps.setOpaque(PS_PARSE_ERROR);
      return text.length;
    }
    psStatements(text.slice(i + 2, close), ps);
    return close + 1;
  }
  return psVariable(text, i, ps);
}

// `@{ Name = $_.Name; GB = [math]::Round(…) }`: each value is a statement.
function psHashtable(inner: string, ps: PsState) {
  for (const entry of splitTopLevel(inner)) {
    if (entry.trim() === "") continue;
    const eq = topLevelIndex(entry, "=");
    if (eq < 0) {
      ps.setOpaque(PS_PARSE_ERROR);
      continue;
    }
    psElement(entry.slice(0, eq).trim(), ps, false);
    psStatements(entry.slice(eq + 1), ps);
  }
}

// The entries of a hashtable, split on `;` and new lines outside quotes and brackets.
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(src, i, ch);
      if (quoted === null) break;
      i = quoted.end - 1;
    } else if (ch === "`") i++;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (depth === 0 && (ch === ";" || ch === "\n")) {
      parts.push(src.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(src.slice(from));
  return parts;
}

// The first `ch` outside quotes and brackets, or -1.
function topLevelIndex(src: string, target: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(src, i, ch);
      if (quoted === null) return -1;
      i = quoted.end - 1;
    } else if (ch === "`") i++;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (depth === 0 && ch === target) return i;
  }
  return -1;
}

// A .NET type name as the lists above know it: lower case, without `System.` or `[]`.
function psTypeName(inner: string): string {
  return inner
    .trim()
    .toLowerCase()
    .replace(/^system\./, "")
    .replace(/\[\]$/, "");
}

function psType(inner: string, ps: PsState) {
  if (!PS_SAFE_TYPES.has(psTypeName(inner))) ps.setOpaque(`uses the .NET type \`[${inner}]\``);
}

// A program named with `.exe` is that program; a bare name may be an alias.
function resolvePsName(name: string): string {
  const bare = basename(name);
  if (/\.exe$/i.test(bare)) return bare.slice(0, -4);
  return PS_ALIASES[bare.toLowerCase()] ?? bare;
}

// Tokenize PowerShell source into a flat list of tokens, tracking quotes, groups, script blocks
// and redirections; the inside of a group stays in its word and is read later. Each token keeps
// where it is in the source. Returns null when the input is malformed (unterminated quote or
// block), which makes the classifier ask.
function tokenizePowershell(src: string): PsToken[] | null {
  const tokens: PsToken[] = [];
  let i = 0;
  const n = src.length;
  let word = "";
  let wordValue = "";
  let wordHasSubexpr = false;
  let wordStartsVariable = false;
  let wordStart = 0;
  let inWord = false;

  const pushWord = () => {
    if (!inWord) return;
    tokens.push({
      kind: "word",
      text: word,
      value: wordValue,
      hasSubexpr: wordHasSubexpr,
      isVariable: wordStartsVariable && !/[)\]}]/.test(wordValue),
      start: wordStart,
      end: i,
    });
    word = "";
    wordValue = "";
    wordHasSubexpr = false;
    wordStartsVariable = false;
    inWord = false;
  };

  const startWord = () => {
    if (!inWord) {
      inWord = true;
      wordStart = i;
      wordStartsVariable = src[i] === "$";
    }
  };

  while (i < n) {
    const ch = src[i];
    if (ch === undefined) break;

    // Line continuation.
    if (ch === "`" && i + 1 < n) {
      startWord();
      word += ch + src[i + 1];
      wordValue += src[i + 1] === "n" || src[i + 1] === "t" ? "" : (src[i + 1] ?? "");
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // Here-string @' ... '@ or @" ... "@.
      if (inWord && word.endsWith("@")) {
        const end = src.indexOf(`${ch}@`, i + 1);
        if (end < 0) return null;
        const body = src.slice(i + 1, end);
        word += `${ch}${body}${ch}@`;
        if (ch === '"' && /\$\(/.test(body)) wordHasSubexpr = true;
        wordValue += body;
        i = end + 2;
        continue;
      }
      const quote = readQuoted(src, i, ch);
      if (quote === null) return null;
      startWord();
      word += src.slice(i, quote.end);
      wordValue += quote.value;
      if (ch === '"' && quote.hasSubexpr) wordHasSubexpr = true;
      i = quote.end;
      continue;
    }

    if (ch === "$" && src[i + 1] === "(") {
      const close = matchDelimiter(src, i + 1, "(", ")");
      if (close < 0) return null;
      startWord();
      word += src.slice(i, close + 1);
      wordHasSubexpr = true;
      i = close + 1;
      continue;
    }

    if (ch === "(") {
      const close = matchDelimiter(src, i, "(", ")");
      if (close < 0) return null;
      startWord();
      const body = src.slice(i + 1, close);
      word += src.slice(i, close + 1);
      // A grouping expression can contain a command; treat it as a sub-expression.
      wordHasSubexpr = true;
      wordValue += body;
      i = close + 1;
      continue;
    }

    if (ch === "{") {
      const close = matchDelimiter(src, i, "{", "}");
      if (close < 0) return null;
      if (inWord && word.endsWith("$")) {
        // A variable with braces, `${name}` or `${C:ile}`: part of the word.
        const end = src.indexOf("}", i);
        if (end < 0) return null;
        word += src.slice(i, end + 1);
        wordValue += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (inWord && word.endsWith("@")) {
        // A hashtable, `@{ … }`: part of the word, read with it.
        word += src.slice(i, close + 1);
        wordValue += src.slice(i, close + 1);
        wordHasSubexpr = true;
        i = close + 1;
        continue;
      }
      pushWord();
      tokens.push({
        kind: "block",
        text: src.slice(i, close + 1),
        inner: src.slice(i + 1, close),
        start: i,
        end: close + 1,
      });
      i = close + 1;
      continue;
    }

    // Redirections.
    const redir = readRedirect(src, i);
    if (redir) {
      pushWord();
      tokens.push({ kind: "redirect", write: redir.write, start: i, end: redir.end });
      i = redir.end;
      continue;
    }

    if (ch === "|") {
      pushWord();
      // `||` is a separator too.
      const text = src[i + 1] === "|" ? "||" : "|";
      tokens.push({ kind: "op", text, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    if (ch === "&") {
      pushWord();
      const text = src[i + 1] === "&" ? "&&" : "&";
      tokens.push({ kind: "op", text, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pushWord();
      tokens.push({ kind: "op", text: ";", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      i++;
      continue;
    }
    if (ch === "#" && !inWord) {
      // Comment to end of line.
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    // Invocation operator `.` or `&` handled above; a leading `.` before whitespace, where a
    // command starts. Elsewhere it is an argument: `Get-Item .` is the current folder.
    const previous = tokens[tokens.length - 1];
    if (
      ch === "." &&
      !inWord &&
      /\s/.test(src[i + 1] ?? " ") &&
      (previous === undefined || previous.kind === "op")
    ) {
      tokens.push({ kind: "invoke", start: i, end: i + 1 });
      i++;
      continue;
    }

    startWord();
    word += ch;
    wordValue += ch;
    i++;
  }
  pushWord();

  // Rewrite a leading `&` op at command position as an invoke token.
  return tokens.map((t) =>
    t.kind === "op" && t.text === "&" ? { kind: "invoke" as const, start: t.start, end: t.end } : t,
  );
}

function readQuoted(
  src: string,
  start: number,
  quote: string,
): { end: number; value: string; hasSubexpr: boolean } | null {
  let i = start + 1;
  let value = "";
  let hasSubexpr = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === quote) {
      // Doubled quote is an escaped quote.
      if (src[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { end: i + 1, value, hasSubexpr };
    }
    if (quote === '"' && ch === "`" && i + 1 < src.length) {
      value += src[i + 1];
      i += 2;
      continue;
    }
    if (quote === '"' && ch === "$" && src[i + 1] === "(") {
      const close = matchDelimiter(src, i + 1, "(", ")");
      if (close < 0) return null;
      hasSubexpr = true;
      value += src.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    value += ch;
    i++;
  }
  return null;
}

// Find the index of the delimiter that closes the one at `open`, respecting nesting and quotes.
function matchDelimiter(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const q = readQuoted(src, i, ch);
      if (q === null) return -1;
      i = q.end;
      continue;
    }
    if (ch === "`") {
      i += 2;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function readRedirect(src: string, i: number): { end: number; write: boolean } | null {
  const rest = src.slice(i);
  // Descriptor-merging redirections such as 2>&1, *>&1 are not writes to a file.
  const merge = rest.match(/^(?:\d+|\*)?>&\d+/);
  if (merge) return { end: i + merge[0].length, write: false };
  const write = rest.match(/^(?:\d+|\*)?>>?/);
  if (write) return { end: i + write[0].length, write: true };
  return null;
}
