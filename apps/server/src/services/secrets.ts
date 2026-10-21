// Values that look like credentials. Used to keep secrets out of the wiki (R-SEC): the wiki is
// shared with every person and colleague of the office and sent to model providers.
const SECRET_PATTERNS: [kind: string, pattern: RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["an API token", /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,})/g],
];

// Credentials written inside other text, found the same way by the write check, the masking of
// command output and the redaction of imported notes and uploaded documents: the value is the
// second group, what precedes it the first.
const EMBEDDED_SECRETS: [kind: string, pattern: RegExp][] = [
  // DB_PASSWORD=x, export API_TOKEN="x": "_" is a word character, so the labels below miss them.
  [
    "a password or key value",
    /\b([A-Za-z][A-Za-z0-9]*_(?:[A-Za-z0-9]*_)*(?:PASSWORD|PASSWD|PWD|PASS|SECRET|TOKEN|API_?KEY|ACCESS_KEY)(?:_[A-Z0-9]+)*\s*[:=]\s*["']?)(?![<[{$*])([^\s"']{4,})/g,
  ],
  // postgres://user:password@host, smb://DOMAIN;user:password@server
  [
    "a password in a connection string",
    /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:)(?![<[{$*])([^\s@/]{3,})(?=@)/gi,
  ],
  // JSON Web Tokens: header.payload.signature, the first two base64url JSON.
  ["a token", /()(\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g],
];

// "password: value" and similar; placeholders such as <password> or [secret removed] are fine.
const LABELLED_VALUE =
  /\b(password|passwd|pwd|pw|psw|secret|token|api[_ -]?key)\b\s*[:=]\s*["'`]?(?![<[{$*])([^\s"'`]{4,})([^\n]*)/gi;

// After a label, a credential and a sentence look alike: "token: estrarre il JWT" is Italian
// prose, "password: Acme1." is not. A value is taken for a credential when it looks like one
// (a digit, a symbol, a capital inside the word) or when it stands alone after its label, the way
// credentials are written down; an ordinary word followed by more words is a sentence.
function looksLikeCredential(value: string, rest: string) {
  const word = value.replace(/[.,;:)\]]+$/, "");
  if (word.length < 4) {
    return false;
  }
  if (/\d/.test(word) || /[^\p{L}]/u.test(word) || /\p{Ll}\p{Lu}/u.test(word)) {
    return true;
  }
  return rest.replace(/["'`*|.,;:)\]\s]/g, "") === "";
}

export type LikelySecret = {
  kind: string;
  line: number;
  // Where it is, without repeating it: the label and the first characters of the value.
  excerpt: string;
};

function lineOf(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

// The first likely secret found, or null.
export function findLikelySecret(text: string): LikelySecret | null {
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      return { kind, line: lineOf(text, match.index), excerpt: `${match[0].slice(0, 4)}…` };
    }
  }
  for (const [kind, pattern] of EMBEDDED_SECRETS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && !(match[2] ?? "").includes(MARK)) {
      const label = (match[1] ?? "").trim();
      return {
        kind,
        line: lineOf(text, match.index),
        excerpt: `${label ? `${label.slice(0, 40)} ` : ""}${(match[2] ?? "").slice(0, 2)}…`,
      };
    }
  }
  LABELLED_VALUE.lastIndex = 0;
  for (const match of text.matchAll(LABELLED_VALUE)) {
    const [, label = "", value = "", rest = ""] = match;
    if (looksLikeCredential(value, rest)) {
      return {
        kind: "a password or key value",
        line: lineOf(text, match.index),
        excerpt: `${label}: ${value.slice(0, 2)}…`,
      };
    }
  }
  // Whatever the redaction of notes and documents would remove ("password del NAS: x", a table row
  // of credentials, a lone password line): one detector for writing and for importing.
  const redacted = redactSecrets(text);
  if (redacted.count > 0) {
    const before = text.split("\n");
    const after = redacted.text.split("\n");
    const index = before.findIndex((line, position) => line !== after[position]);
    const line = before[index] ?? "";
    return {
      kind: "a password or key value",
      line: index + 1,
      excerpt: `${line.trim().slice(0, 12)}…`,
    };
  }
  return null;
}

const MARK = "[secret removed]";
const MASK_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,})/g,
];
const MASK_VALUE =
  /\b((?:password|passwd|pwd|pw|psw|secret|token|api[_ -]?key)\b\s*[:=]\s*["'`]?)(?![<[{$*])[^\s"'`]{4,}/gi;

// Hides values that look like credentials in command output and logs (R-SEC-3).
export function maskLikelySecrets(text: string) {
  let masked = text;
  for (const pattern of MASK_PATTERNS) {
    masked = masked.replace(pattern, MARK);
  }
  for (const [, pattern] of EMBEDDED_SECRETS) {
    masked = masked.replace(pattern, (_match, prefix: string) => `${prefix}${MARK}`);
  }
  return masked.replace(MASK_VALUE, (_match, prefix: string) => `${prefix}${MARK}`);
}

// Labels written before a credential in notes, in English and Italian. A label may be bold
// (**Password:**) and the value in backticks or quotes.
const SECRET_LABEL = String.raw`(?:password|passwd|passphrase|pwd|pw|psw|pass|secret(?:[ _-]?access[ _-]?key)?|token|api[ _-]?key|auth[ _-]?key|psk|chiave[ _-]?(?:wpa2?|wi-?fi|api|segreta|di accesso))`;
// "password dominio: x", "password locale di fallback: x": up to three words may qualify the label.
const NOTE_LABELLED = new RegExp(
  String.raw`(\b${SECRET_LABEL}\b(?:[ \t]+[\p{L}\d_-]+){0,3}(?:\*\*|__)?[ \t]*[:=][ \t]*(?:\*\*|__)?[ \t]*)(\x60[^\x60\s]+\x60|"[^"\s]+"|'[^'\s]+'|[^\s|"'\x60][^\s|]*)([^\n]*)`,
  "giu",
);
// "la password degli utenti X è "valore"": a quoted value later in the sentence of a label.
const NOTE_QUOTED = new RegExp(
  String.raw`(\b${SECRET_LABEL}\b[^\n"\x60.]{0,60}?\s(?:è|e'|is|vale)\s+)("[^"\s]{3,}"|\x60[^\x60\s]{3,}\x60)`,
  "giu",
);
// A line holding nothing but a password-like word, as in a list of accounts: 10+ characters mixing
// at least three of lowercase, uppercase, digits and symbols.
function isBareCredential(line: string) {
  // Bold, quotes and backticks around it are not part of it.
  const word = line.trim().replace(/^(\*\*|__|["'\x60“”])+|(\*\*|__|["'\x60“”])+$/g, "");
  if (word.length < 10 || word.length > 64 || /\s/.test(word) || /[/\\:@]/.test(word)) {
    return false;
  }
  // NAME=value is an assignment, judged by its name above, not a password on its own.
  if (/^[A-Za-z_][\w.-]*=/.test(word)) {
    return false;
  }
  // Identifiers and hashes (hex and dashes), file names.
  if (/^[\da-f-]+$/i.test(word) || /\.[a-z\d]{2,5}$/i.test(word)) {
    return false;
  }
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\d/, /[^\p{L}\d]/u].filter((re) => re.test(word));
  return classes.length >= 3;
}
const TABLE_LABEL = new RegExp(String.raw`^\W*${SECRET_LABEL}\W*$`, "i");
// NUT's upsmon.conf: MONITOR <ups> <power> <user> <password> <primary|secondary>.
const NUT_MONITOR =
  /(\bMONITOR\s+\S+\s+\d+\s+\S+\s+)(\S+)(?=\s+(?:master|slave|primary|secondary)\b)/g;
const AUTH_HEADER = /\b(Authorization:\s*[A-Za-z-]+\s+)([A-Za-z0-9._~+/=:-]{8,})/gi;

function maskQuoted(value: string) {
  const quote = value[0] === "`" || value[0] === '"' || value[0] === "'" ? value[0] : "";
  return quote ? `${quote}${MARK}${quote}` : MARK;
}

// Removes what looks like a credential from a note before it enters the wiki (R-SEC): labelled
// values, values in a table row whose first cell is a credential label, private keys, known
// token formats and Authorization headers. Placeholders and prose after a label are kept.
// Returns the text and how many values were removed.
export function redactSecrets(text: string) {
  let count = 0;
  let out = text;
  for (const pattern of MASK_PATTERNS) {
    out = out.replace(pattern, () => {
      count += 1;
      return MARK;
    });
  }
  for (const [, pattern] of EMBEDDED_SECRETS) {
    out = out.replace(pattern, (match, prefix: string, value: string) => {
      if (value.includes(MARK)) {
        return match;
      }
      count += 1;
      return `${prefix}${MARK}`;
    });
  }
  out = out.replace(NUT_MONITOR, (match, prefix: string, value: string) => {
    if (value.includes(MARK)) {
      return match;
    }
    count += 1;
    return `${prefix}${MARK}`;
  });
  out = out.replace(AUTH_HEADER, (_match, prefix: string) => {
    count += 1;
    return `${prefix}${MARK}`;
  });
  out = out.replace(NOTE_LABELLED, (match, prefix: string, word: string, after: string) => {
    // "(user: admin, pass: x)": closing brackets and commas belong to the sentence. A final dot
    // stays with the value, where passwords often have one.
    const tail = /^[^`"']/.test(word) ? (/[),;\]]+$/.exec(word)?.[0] ?? "") : "";
    const value = word.slice(0, word.length - tail.length);
    const rest = tail + after;
    const bare = value.replace(/^[`"']|[`"']$/g, "");
    if (bare.includes(MARK) || /^[<[{$*]/.test(bare)) {
      return match;
    }
    // A value in backticks or quotes is a value; a bare word must look like a credential. A short
    // one counts only alone on its line ("Pwd: abc").
    const alone = rest.replace(/["'\x60*|.,;:)\]\s]/g, "") === "";
    if (bare === value && !looksLikeCredential(bare, rest) && !(alone && bare.length >= 3)) {
      return match;
    }
    count += 1;
    return `${prefix}${maskQuoted(value)}${rest}`;
  });
  out = out.replace(NOTE_QUOTED, (match, prefix: string, value: string) => {
    if (value.includes(MARK)) {
      return match;
    }
    count += 1;
    return `${prefix}${maskQuoted(value)}`;
  });
  let inCode = false;
  out = out
    .split("\n")
    .map((line) => {
      if (/^\s*(\x60\x60\x60|~~~)/.test(line)) {
        inCode = !inCode;
        return line;
      }
      if (!inCode && isBareCredential(line)) {
        count += 1;
        return line.replace(line.trim(), MARK);
      }
      if (!line.trimStart().startsWith("|")) {
        return line;
      }
      const cells = line.split("|");
      // cells[0] is what precedes the first pipe; the label is the first real cell.
      if (cells.length < 4 || !TABLE_LABEL.test(cells[1] ?? "")) {
        return line;
      }
      const value = (cells[2] ?? "").trim();
      if (!value || value.includes(MARK) || /^[-:]+$/.test(value) || /^[<[{$*]/.test(value)) {
        return line;
      }
      count += 1;
      cells[2] = ` ${maskQuoted(value)} `;
      return cells.join("|");
    })
    .join("\n");
  return { text: out, count };
}
