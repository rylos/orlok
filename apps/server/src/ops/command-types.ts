// R-OPS-4: the type of a command, what "allow always" remembers (decided 2026-10-05).
// A type is the program and the first one, two or three words after it, as the table below
// says: `systemctl restart nginx` is `systemctl restart`, `docker compose up -d` is
// `docker compose up`. A program not in the table is its first word. The idea and the shape of
// the table come from OpenCode (permission/arity.ts); the entries are ours, for the Linux and
// Windows machines colleagues work on.

import type { ShellKind } from "@orlok/shared";

// How many words make the type when the command starts with the key. The longest key that
// matches wins. Programs with a one-word type (rm, cp, kill, Restart-Service…) are not listed.
const POSIX_WORDS: Record<string, number> = {
  systemctl: 2,
  timedatectl: 2,
  hostnamectl: 2,
  apt: 2,
  "apt-get": 2,
  dnf: 2,
  yum: 2,
  snap: 2,
  git: 2,
  docker: 2,
  kubectl: 2,
  helm: 2,
  ip: 2,
  nft: 2,
  ufw: 2,
  zfs: 2,
  zpool: 2,
  qm: 2,
  pct: 2,
  pvesh: 2,
  pvesm: 2,
  pvecm: 2,
  certbot: 2,
  apachectl: 2,
  openssl: 2,
  rclone: 2,
  restic: 2,
  borg: 2,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  "docker system": 3,
  "ip addr": 3,
  "ip link": 3,
  "ip route": 3,
  "ip neigh": 3,
  "nmcli connection": 3,
  "nmcli device": 3,
  "git remote": 3,
  "git stash": 3,
  "git config": 3,
  "kubectl rollout": 3,
  // The service name is part of the type: `service nginx restart`.
  service: 3,
};

// Windows: a cmdlet name (Verb-Noun) is already a precise type. Classic programs take their
// action as the next word, and for them a /switch counts as a word: `schtasks /create`.
// Lower case: PowerShell does not tell case apart.
const POWERSHELL_WORDS: Record<string, number> = {
  net: 2,
  sc: 2,
  reg: 2,
  schtasks: 2,
  wevtutil: 2,
  dnscmd: 2,
  netdom: 2,
  winget: 2,
  choco: 2,
  wmic: 2,
  netsh: 3,
};

// A word of a command: its text, and whether it is fixed (no variable, substitution or glob).
export type CommandWord = { value: string; fixed: boolean };

// The type of one command, or null when a word that makes it is not fixed (`systemctl $action`):
// what the command would be is known only when it runs. Options (-x, --xyz, -Name) are not words
// of the type, so `systemctl --no-pager restart nginx` is still `systemctl restart`. `prefix`
// carries a wrapper that changes what the command may do, such as sudo: `sudo systemctl restart`
// is a type of its own.
export function commandType(
  shell: ShellKind,
  program: string,
  args: CommandWord[],
  prefix?: string,
): string | null {
  const words = [{ value: program, fixed: true }, ...args.filter((arg) => !isOption(arg.value))];
  const table = shell === "powershell" ? POWERSHELL_WORDS : POSIX_WORDS;
  const key = (count: number) => {
    const text = words
      .slice(0, count)
      .map((word) => word.value)
      .join(" ");
    return shell === "powershell" ? text.toLowerCase() : text;
  };
  let count = 1;
  for (const length of [3, 2, 1]) {
    if (words.length < length) continue;
    const found = table[key(length)];
    if (found !== undefined) {
      count = found;
      break;
    }
  }
  const typeWords = words.slice(0, count);
  if (typeWords.some((word) => !word.fixed || word.value === "")) {
    return null;
  }
  const type = typeWords.map((word) => word.value).join(" ");
  return prefix ? `${prefix} ${type}` : type;
}

function isOption(value: string) {
  return value.length > 1 && value.startsWith("-");
}

// What makes two types the same: PowerShell does not tell case apart, a POSIX shell does.
export function typeKey(shell: ShellKind, type: string): string {
  return `${shell}:${shell === "powershell" ? type.toLowerCase() : type}`;
}

// A file written with `>` is a piece of the command with a type of its own, as `tee` is.
export const WRITE_TYPE = ">";
