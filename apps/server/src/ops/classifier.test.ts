import type { CommandRule, ExecMode, ShellKind } from "@orlok/shared";
import { describe, expect, test } from "vitest";
import { classifyCommand, type TypeApprovals } from "./classifier.js";
import { typeKey } from "./command-types.js";

// Types a person approved "always", and those an administrator disabled.
function approvals(shell: ShellKind, approved: string[], blocked: string[] = []): TypeApprovals {
  return {
    approved: new Set(approved.map((type) => typeKey(shell, type))),
    blocked: new Set(blocked.map((type) => typeKey(shell, type))),
  };
}

// Helper: classify in ask mode (read-only commands and approved types run) and return the result.
function c(command: string, shell: ShellKind = "posix", approved?: TypeApprovals) {
  return classifyCommand(command, shell, { mode: "ask", approvals: approved });
}

// A table row: [command, shell, expected decision, reason fragment?].
type Row = [string, ShellKind, "allow" | "ask" | "deny", string?];

describe("allowlisted read-only commands (POSIX)", () => {
  const rows: Row[] = [
    ["ls", "posix", "allow"],
    ["ls -la /var/log", "posix", "allow"],
    ["cat /etc/hosts", "posix", "allow"],
    ["cat /var/log/syslog", "posix", "allow"],
    ["head -n 20 file.log", "posix", "allow"],
    ["tail -f /var/log/app.log", "posix", "allow"],
    ["grep -i error app.log", "posix", "allow"],
    ["egrep 'a|b' file", "posix", "allow"],
    ["wc -l file", "posix", "allow"],
    ["stat /etc/hosts", "posix", "allow"],
    ["file /bin/ls", "posix", "allow"],
    ["uptime", "posix", "allow"],
    ["uname -a", "posix", "allow"],
    ["hostname -f", "posix", "allow"],
    ["whoami", "posix", "allow"],
    ["id", "posix", "allow"],
    ["date", "posix", "allow"],
    ["df -h", "posix", "allow"],
    ["du -sh /var", "posix", "allow"],
    ["free -m", "posix", "allow"],
    ["lsblk", "posix", "allow"],
    ["ss -tlnp", "posix", "allow"],
    ["netstat -an", "posix", "allow"],
    ["ps aux", "posix", "allow"],
    ["top -b -n 1", "posix", "allow"],
    ["dig example.com", "posix", "allow"],
    ["nslookup example.com", "posix", "allow"],
    ["host example.com", "posix", "allow"],
    ["traceroute example.com", "posix", "allow"],
    ["mtr --report example.com", "posix", "allow"],
    ["ping -c 4 example.com", "posix", "allow"],
    ["ping -c 20 example.com", "posix", "allow"],
    ["nc -z -w 3 host 22", "posix", "allow"],
    ["ssh-keyscan host", "posix", "allow"],
    ["ip addr show", "posix", "allow"],
    ["ip route", "posix", "allow"],
    ["ip link show", "posix", "allow"],
    ["systemctl status nginx", "posix", "allow"],
    ["systemctl is-active nginx", "posix", "allow"],
    ["systemctl list-units", "posix", "allow"],
    ["systemctl show nginx", "posix", "allow"],
    ["journalctl -n 50 --no-pager", "posix", "allow"],
    ["journalctl --since '1 hour ago' --no-pager", "posix", "allow"],
    ["docker ps", "posix", "allow"],
    ["docker images", "posix", "allow"],
    ["docker logs --tail 100 web", "posix", "allow"],
    ["docker inspect web", "posix", "allow"],
    ["docker stats --no-stream", "posix", "allow"],
    ["pvesh get /nodes", "posix", "allow"],
    ["qm list", "posix", "allow"],
    ["qm status 100", "posix", "allow"],
    ["pct list", "posix", "allow"],
    ["zpool status", "posix", "allow"],
    ["zfs list", "posix", "allow"],
    ["smartctl -a /dev/sda", "posix", "allow"],
    ["smartctl -H /dev/nvme0", "posix", "allow"],
    ["find /var/log -name '*.log'", "posix", "allow"],
    ["sort file", "posix", "allow"],
    ["uniq file", "posix", "allow"],
    ["cut -d: -f1 /etc/passwd", "posix", "allow"],
    ["jq '.items' data.json", "posix", "allow"],
    ["awk '{print $1}' file", "posix", "allow"],
    ["sed -n '1,10p' file", "posix", "allow"],
    ["openssl x509 -noout -text -in cert.pem", "posix", "allow"],
    ["curl -I https://example.com", "posix", "allow"],
    ["curl -sL https://example.com", "posix", "allow"],
    ["curl --max-time 5 -o /dev/null -w '%{http_code}' https://example.com", "posix", "allow"],
  ];
  test.each(rows)("%s", (cmd, shell, want) => {
    expect(c(cmd, shell).decision).toBe(want);
  });
});

describe("pipelines and lists of allowed commands", () => {
  const rows: Row[] = [
    ["journalctl -n 50 --no-pager | grep -i error", "posix", "allow"],
    ["ps aux | grep nginx | wc -l", "posix", "allow"],
    ["cat /etc/passwd | cut -d: -f1 | sort | uniq", "posix", "allow"],
    ["ls -la && df -h", "posix", "allow"],
    ["uptime; free -m; df -h", "posix", "allow"],
    ["dig example.com || host example.com", "posix", "allow"],
    ["( ls -la; cat file )", "posix", "allow"],
    ["{ ls; df -h; }", "posix", "allow"],
    ["ls 2>&1 | grep x", "posix", "allow"],
    ["grep error < input.log", "posix", "allow"],
    ["cat a > /dev/null", "posix", "allow"],
    ["[[ -f /etc/hosts ]] && cat /etc/hosts", "posix", "allow"],
    ["for i in a b c; do cat $i; done", "posix", "allow"],
    ["while read l; do echo $l; done < file", "posix", "ask", "`read`, `echo` need approval"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("unsafe structures ask with a precise reason", () => {
  const rows: Row[] = [
    ["ls $(whoami)", "posix", "ask", "command substitution"],
    ["ls `whoami`", "posix", "ask", "command substitution"],
    ['cat "$(echo /etc/hosts)"', "posix", "ask", "command substitution"],
    ["diff <(ls a) <(ls b)", "posix", "ask", "process substitution"],
    ["eval ls", "posix", "ask", "`eval`"],
    ["exec ls", "posix", "ask", "`exec`"],
    ["source script.sh", "posix", "ask", "`source`"],
    [". script.sh", "posix", "ask", "`.`"],
    ["ls > out.txt", "posix", "ask", "`>` needs approval"],
    ["ls >> out.txt", "posix", "ask", "`>` needs approval"],
    ["ls >| out.txt", "posix", "ask", "`>` needs approval"],
    ["ls &> out.txt", "posix", "ask", "`>` needs approval"],
    ["cat a > b.txt", "posix", "ask", "`>` needs approval"],
    ["ls &", "posix", "ask", "background"],
    ["cat file &", "posix", "ask", "background"],
    ["PATH=/tmp ls", "posix", "ask", "`PATH`"],
    ["LD_PRELOAD=/x.so ls", "posix", "ask", "`LD_PRELOAD`"],
    ["IFS=x ls", "posix", "ask", "`IFS`"],
    ["$cmd arg", "posix", "ask", "expansion"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not JS.
    ["${prog} arg", "posix", "ask", "expansion"],
    ["* -la", "posix", "ask", "expansion"],
    ["myfunc() { rm x; }", "posix", "ask", "function"],
    ["sh -c 'ls'", "posix", "ask", "interpreter"],
    ["bash", "posix", "ask", "interpreter"],
    ["python -c 'print(1)'", "posix", "ask", "interpreter"],
    ["python3 script.py", "posix", "ask", "interpreter"],
    ["node -e 'console.log(1)'", "posix", "ask", "interpreter"],
    ["perl -e 'print 1'", "posix", "ask", "interpreter"],
    ["ruby -e 'puts 1'", "posix", "ask", "interpreter"],
    ["x=1", "posix", "ask", "variable"],
    ["coproc ls", "posix", "ask", "coprocess"],
    ["select x in a b; do echo $x; done", "posix", "ask", "select"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

// sudo and doas are part of the type; timeout, nice and nohup change nothing; the others run
// something that is not read here.
describe("wrappers", () => {
  const rows: Row[] = [
    ["sudo ls", "posix", "ask", "`sudo ls` needs approval"],
    ["sudo cat /etc/hosts", "posix", "ask", "`sudo cat` needs approval"],
    ["doas ls", "posix", "ask", "`doas ls` needs approval"],
    ["su -c ls", "posix", "ask", "`su` runs another command"],
    ["env FOO=bar ls", "posix", "ask", "`env` runs another command"],
    ["nohup ls", "posix", "allow"],
    ["timeout 5 ping -c1 example.com", "posix", "allow"],
    ["nice -n 10 ls", "posix", "allow"],
    ["watch ls", "posix", "ask", "`watch` runs another command"],
    ["xargs ls", "posix", "ask", "`xargs` runs another command"],
    ["find . -type f | xargs grep foo", "posix", "ask", "xargs"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("commands that are not read-only ask for their type", () => {
  const rows: Row[] = [
    ["rm -rf /tmp/x", "posix", "ask", "`rm` needs approval"],
    ["mv a b", "posix", "ask", "`mv` needs approval"],
    ["cp a b", "posix", "ask", "`cp` needs approval"],
    ["touch file", "posix", "ask", "`touch` needs approval"],
    ["mkdir dir", "posix", "ask", "`mkdir` needs approval"],
    ["kill 1234", "posix", "ask", "`kill` needs approval"],
    ["reboot", "posix", "ask", "`reboot` needs approval"],
    ["shutdown -h now", "posix", "ask", "`shutdown` needs approval"],
    ["poweroff", "posix", "ask", "`poweroff` needs approval"],
    ["init 6", "posix", "ask", "`init` needs approval"],
    ["ls -la; rm file", "posix", "ask", "`rm` needs approval"],
    ["cat file | tee out", "posix", "ask", "`tee` needs approval"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("read-only programs asked on argument misuse", () => {
  const rows: Row[] = [
    ["ping example.com", "posix", "ask", "`ping` needs approval"], // no -c
    ["ping -c 21 example.com", "posix", "ask"],
    ["ping -c 100 example.com", "posix", "ask"],
    ["ping -f -c 1 example.com", "posix", "ask"],
    ["nc host 22", "posix", "ask"], // no -z -w
    ["nc -z -w 3 -e /bin/sh host 22", "posix", "ask"],
    ["ip addr add 10.0.0.1/24 dev eth0", "posix", "ask"],
    ["ip route del default", "posix", "ask"],
    ["ip link set eth0 down", "posix", "ask"],
    ["systemctl restart nginx", "posix", "ask"],
    ["systemctl stop nginx", "posix", "ask"],
    ["systemctl enable nginx", "posix", "ask"],
    ["journalctl", "posix", "ask"], // no --no-pager
    ["journalctl -f", "posix", "ask"],
    ["docker run -it ubuntu", "posix", "ask"],
    ["docker exec web sh", "posix", "ask"],
    ["docker rm web", "posix", "ask"],
    ["docker stats", "posix", "ask"], // streams
    ["top", "posix", "ask"], // interactive
    ["qm start 100", "posix", "ask"],
    ["pct stop 100", "posix", "ask"],
    ["zpool destroy tank", "posix", "ask"],
    ["zfs destroy tank/data", "posix", "ask"],
    ["smartctl -t long /dev/sda", "posix", "ask"],
    ["find /var -delete", "posix", "ask", "delete"],
    ["find . -exec rm {} ;", "posix", "ask", "exec"],
    ["find . -exec rm {} +", "posix", "ask", "exec"],
    ["sed -i s/a/b/ file", "posix", "ask", "in place"],
    ["awk '{system(\"rm x\")}' file", "posix", "ask", "run commands"],
    ["awk '{print > \"out\"}' file", "posix", "ask"],
    ["curl -X POST https://x", "posix", "ask", "non-GET"],
    ["curl -d name=x https://x", "posix", "ask", "uploads"],
    ["curl --data-binary @f https://x", "posix", "ask", "uploads"],
    ["curl -F file=@f https://x", "posix", "ask", "uploads"],
    ["curl -T file https://x", "posix", "ask", "uploads a file"],
    ["curl -o /tmp/out https://x", "posix", "ask", "writes"],
    ["curl -O https://x/f", "posix", "ask", "writes"],
    ["curl -K config https://x", "posix", "ask", "config"],
    ["wget https://x/f", "posix", "ask"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("sensitive paths turn read into ask", () => {
  const rows: Row[] = [
    ["cat /etc/shadow", "posix", "ask", "sensitive"],
    ["cat /etc/gshadow", "posix", "ask", "sensitive"],
    ["grep root /etc/sudoers", "posix", "ask", "sensitive"],
    ["cat ~/.ssh/id_rsa", "posix", "ask", "sensitive"],
    ["cat /home/x/.ssh/id_ed25519", "posix", "ask", "sensitive"],
    ["cat /root/.ssh/authorized_keys", "posix", "ask", "sensitive"],
    ["head server.key", "posix", "ask", "sensitive"],
    ["cat cert.pem", "posix", "ask", "sensitive"],
    ["cat .env", "posix", "ask", "sensitive"],
    ["cat app.env", "posix", "ask", "sensitive"],
    ["cat ~/.aws/credentials", "posix", "ask", "sensitive"],
    ["cat .pgpass", "posix", "ask", "sensitive"],
    ["tail -n 5 /var/log/app.env", "posix", "ask", "sensitive"],
    // Public keys and ordinary files are fine.
    ["cat id_rsa.pub", "posix", "allow"],
    ["cat /etc/hosts", "posix", "allow"],
    ["cat README.md", "posix", "allow"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("quoting and injection tricks", () => {
  const rows: Row[] = [
    ["'r''m' -rf /tmp/x", "posix", "ask", "`rm` needs approval"],
    ["r\\m /tmp/x", "posix", "ask", "`rm` needs approval"],
    ["$'\\x72\\x6d' /tmp/x", "posix", "ask", "`rm` needs approval"],
    ['"$(echo rm)" x', "posix", "ask", "command substitution"],
    ["ls;rm file", "posix", "ask", "`rm` needs approval"],
    ["ls&&rm file", "posix", "ask", "`rm` needs approval"],
    ["ls\nrm file", "posix", "ask", "`rm` needs approval"],
    ["ping -c 1 x; rm -rf /tmp/x", "posix", "ask", "`rm` needs approval"],
    ["ls |rm file", "posix", "ask", "`rm` needs approval"],
    ["echo hi; cat /etc/shadow", "posix", "ask"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("deny rules and structural catastrophes", () => {
  const rows: Row[] = [
    ["rm -rf /", "posix", "deny"],
    ["rm -rf /*", "posix", "deny"],
    ["rm -fr /", "posix", "deny"],
    ["rm -r --no-preserve-root /", "posix", "deny"],
    ["mkfs.ext4 /dev/sdb1", "posix", "deny"],
    ["mkfs -t ext4 /dev/sdb1", "posix", "deny"],
    ["wipefs -a /dev/sda", "posix", "deny"],
    ["dd if=/dev/zero of=/dev/sda", "posix", "deny"],
    ["shred -n 3 /dev/sda", "posix", "deny"],
    ["chmod -R 777 /", "posix", "deny"],
    ["chown -R nobody /", "posix", "deny"],
    ["echo x > /dev/sda", "posix", "deny", "block device"],
    ["cat img > /dev/nvme0n1", "posix", "deny", "block device"],
    [":(){ :|:& };:", "posix", "deny", "fork bomb"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("deny hidden inside pipelines and subshells, in every mode", () => {
  const nested = [
    "ls | rm -rf /",
    "( rm -rf / )",
    "ls && rm -rf /",
    "if true; then rm -rf /; fi",
    "for i in a; do rm -rf /; done",
  ];
  const modes: ExecMode[] = ["ask", "full"];
  for (const cmd of nested) {
    for (const mode of modes) {
      test(`${cmd} [${mode}]`, () => {
        const res = classifyCommand(cmd, "posix", { mode });
        expect(res.decision).toBe("deny");
      });
    }
  }
});

describe("mode behaviours", () => {
  test("deny mode refuses everything", () => {
    const res = classifyCommand("ls", "posix", { mode: "deny" });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("disabled");
  });
  test("full mode allows a non-allowlisted command", () => {
    const res = classifyCommand("rm -rf /tmp/x", "posix", { mode: "full" });
    expect(res.decision).toBe("allow");
  });
  test("full mode still denies a deny rule", () => {
    const res = classifyCommand("rm -rf /", "posix", { mode: "full" });
    expect(res.decision).toBe("deny");
  });
  test("full mode still denies inside a pipeline", () => {
    const res = classifyCommand("ls | mkfs.ext4 /dev/sdb", "posix", {
      mode: "full",
    });
    expect(res.decision).toBe("deny");
  });
  test("ask mode runs a read-only command and asks for the rest", () => {
    expect(classifyCommand("ls", "posix", { mode: "ask" }).decision).toBe("allow");
    expect(classifyCommand("systemctl restart nginx", "posix", { mode: "ask" }).decision).toBe(
      "ask",
    );
  });
  test("ask mode still denies a deny rule", () => {
    const res = classifyCommand("rm -rf /", "posix", { mode: "ask" });
    expect(res.decision).toBe("deny");
  });
  test("yolo mode lets deny rules and structural catastrophes through", () => {
    for (const command of ["rm -rf /", "ls | mkfs.ext4 /dev/sdb", ":(){ :|:& };:"]) {
      const res = classifyCommand(command, "posix", { mode: "yolo" });
      expect(res.decision).toBe("allow");
    }
    const format = classifyCommand("Format-Volume -DriveLetter D", "powershell", {
      mode: "yolo",
    });
    expect(format.decision).toBe("allow");
  });
  test("custom deny rule refuses in full mode", () => {
    const denyRules: CommandRule[] = [
      { id: "no-git", shell: "any", program: "git", description: "no git" },
    ];
    const res = classifyCommand("git push", "posix", { mode: "full", denyRules });
    expect(res.decision).toBe("deny");
    expect(res.matchedRules).toContain("no-git");
  });
});

describe("approved types", () => {
  const restart = approvals("posix", ["systemctl restart"]);
  test("an approved type allows the command, whatever its arguments", () => {
    for (const command of ["systemctl restart nginx", "systemctl restart apache2"]) {
      const res = c(command, "posix", restart);
      expect(res.decision).toBe("allow");
      expect(res.matchedRules).toContain("type:systemctl restart");
    }
  });
  test("another type of the same program still asks", () => {
    const res = c("systemctl stop nginx", "posix", restart);
    expect(res).toMatchObject({ decision: "ask", types: ["systemctl stop"], onceOnly: false });
  });
  test("without approvals, restart asks for its type", () => {
    expect(c("systemctl restart nginx")).toMatchObject({
      decision: "ask",
      types: ["systemctl restart"],
      onceOnly: false,
    });
  });
  test("only the missing types of a compound command are asked", () => {
    const res = c("systemctl restart nginx && systemctl status nginx");
    expect(res).toMatchObject({ decision: "ask", types: ["systemctl restart"], onceOnly: false });
    expect(res.reason).toBe("`systemctl restart` needs approval");
    expect(c("systemctl restart nginx && systemctl status nginx", "posix", restart).decision).toBe(
      "allow",
    );
  });
  test("each missing type is asked once", () => {
    const res = c("rm a; mkdir b; rm c");
    expect(res.types).toEqual(["rm", "mkdir"]);
    expect(res.reason).toBe("`rm`, `mkdir` need approval");
  });
  test("a type disabled by an administrator asks once", () => {
    const res = c(
      "systemctl restart nginx",
      "posix",
      approvals("posix", [], ["systemctl restart"]),
    );
    expect(res).toMatchObject({ decision: "ask", onceOnly: true });
    expect(res.reason).toContain("disabled by an administrator");
  });
  test("sudo is a type of its own", () => {
    expect(c("sudo systemctl restart nginx", "posix", restart).types).toEqual([
      "sudo systemctl restart",
    ]);
    const sudo = approvals("posix", ["sudo systemctl restart"]);
    expect(c("sudo systemctl restart nginx", "posix", sudo).decision).toBe("allow");
    expect(c("systemctl restart nginx", "posix", sudo).decision).toBe("ask");
  });
  test("PowerShell types do not tell case apart", () => {
    const ps = approvals("powershell", ["Restart-Service"]);
    expect(c("restart-service Spooler", "powershell", ps).decision).toBe("allow");
    expect(c("Restart-Service Spooler", "posix", ps).decision).toBe("ask");
  });
});

// The type of each piece, from the table in command-types.ts.
describe("command types", () => {
  const rows: [string, ShellKind, string[]][] = [
    ["apt install htop", "posix", ["apt install"]],
    ["apt-get -y install htop", "posix", ["apt-get install"]],
    ["docker compose up -d", "posix", ["docker compose up"]],
    ["docker restart web", "posix", ["docker restart"]],
    ["systemctl --no-pager restart nginx", "posix", ["systemctl restart"]],
    ["/usr/bin/systemctl restart nginx", "posix", ["systemctl restart"]],
    ["service nginx restart", "posix", ["service nginx restart"]],
    ["git push origin main", "posix", ["git push"]],
    ["git remote add origin x", "posix", ["git remote add"]],
    ["ip -br link set eth0 up", "posix", ["ip link set"]],
    ["rm -rf /tmp/x", "posix", ["rm"]],
    ["systemctl restart $svc", "posix", ["systemctl restart"]],
    ["timeout 30 systemctl restart nginx", "posix", ["systemctl restart"]],
    ["sudo -u postgres psql -c 'select 1'", "posix", ["sudo psql"]],
    ["echo hi > /etc/motd", "posix", ["echo", ">"]],
    ["ls > /tmp/list.txt", "posix", [">"]],
    ["sed -i s/a/b/ f && curl -X POST https://x", "posix", ["sed", "curl"]],
    ["Restart-Service Spooler", "powershell", ["Restart-Service"]],
    [
      "Stop-Service Spooler; Start-Service Spooler",
      "powershell",
      ["Stop-Service", "Start-Service"],
    ],
    ["net user mario /add", "powershell", ["net user"]],
    ["net.exe localgroup Administrators mario /add", "powershell", ["net localgroup"]],
    ["schtasks /create /tn backup /tr x", "powershell", ["schtasks /create"]],
    ["netsh advfirewall firewall add rule name=x", "powershell", ["netsh advfirewall firewall"]],
    ["sc.exe config wuauserv start= disabled", "powershell", ["sc config"]],
    ["sc query wuauserv", "powershell", ["Set-Content"]],
    [
      "Get-Service Spooler | ForEach-Object { Restart-Service $_ }",
      "powershell",
      ["Restart-Service"],
    ],
    ["Get-Process | Out-File C:\\procs.txt", "powershell", ["Out-File"]],
    ["Get-Process > C:\\procs.txt", "powershell", [">"]],
    ["New-Service -Name x -BinaryPathName C:\\x.exe", "powershell", ["New-Service"]],
  ];
  test.each(rows)("%s", (cmd, shell, types) => {
    expect(c(cmd, shell)).toMatchObject({ decision: "ask", types, onceOnly: false });
  });

  test("output thrown away is not a write", () => {
    expect(c("ls > /dev/null").decision).toBe("allow");
    expect(c("Get-Process > $null", "powershell").decision).toBe("allow");
  });
  test("git reads run without asking", () => {
    for (const cmd of ["git status", "git -C /srv/app log --oneline -5", "git diff HEAD~1"]) {
      expect(c(cmd).decision).toBe("allow");
    }
    expect(c("git diff --output=/tmp/x").types).toEqual(["git diff"]);
  });
});

// What cannot be read to the end has no type to remember: it asks every time, "once" only.
describe("commands approved once only", () => {
  const rows: [string, ShellKind, string][] = [
    ["systemctl restart $(cat list.txt)", "posix", "command substitution"],
    ["systemctl $action nginx", "posix", "depends on a variable"],
    ["bash -c 'systemctl restart nginx'", "posix", "interpreter `bash`"],
    ["/bin/bash -c id", "posix", "interpreter `bash`"],
    ["python3.11 x.py", "posix", "interpreter `python3.11`"],
    ["./deploy.sh", "posix", "script `./deploy.sh`"],
    ["/opt/app/start.sh --now", "posix", "script `/opt/app/start.sh`"],
    ["ssh root@web01 uptime", "posix", "another machine"],
    ["sudo bash -c id", "posix", "interpreter `bash`"],
    ["sudo $cmd", "posix", "expansion"],
    ["systemctl restart nginx &", "posix", "background"],
    ["cat /root/.ssh/id_rsa", "posix", "sensitive"],
    ["find /tmp -name '*.log' -exec rm {} \\;", "posix", "`find -exec` runs another command"],
    ["awk 'BEGIN { system(\"id\") }'", "posix", "awk program"],
    ["LD_PRELOAD=/tmp/x.so ls", "posix", "LD_PRELOAD"],
    ["cmd /c del C:\\x.txt", "powershell", "interpreter `cmd`"],
    ["powershell -Command Stop-Service x", "powershell", "interpreter `powershell`"],
    [".\\deploy.ps1", "powershell", "script"],
    ["C:\\scripts\\fix.ps1 -Force", "powershell", "script"],
    ["Invoke-Command -ComputerName web01 -ScriptBlock { Get-Date }", "powershell", "runs code"],
    ["get-content app.env", "powershell", "sensitive"],
    ["Get-Credential", "powershell", "secret"],
    ["systemd-run --unit x rm -rf /tmp/x", "posix", "`systemd-run` runs another command"],
    ["command rm -rf /tmp/x", "posix", "`command` runs another command"],
    ["nsenter -t 1 -m -- systemctl restart nginx", "posix", "`nsenter` runs another command"],
    ["runas /user:admin cmd", "powershell", "`runas` runs another command"],
    ["psexec \\web01 cmd", "powershell", "`psexec` runs another command"],
  ];
  test.each(rows)("%s", (cmd, shell, fragment) => {
    const res = c(cmd, shell);
    expect(res).toMatchObject({ decision: "ask", onceOnly: true });
    expect(res.reason).toContain(fragment);
  });
  test("an approved type does not help a line that cannot be read to the end", () => {
    const restart = approvals("posix", ["systemctl restart"]);
    expect(c("systemctl restart $(cat list.txt)", "posix", restart).onceOnly).toBe(true);
  });
});

describe("classification metadata", () => {
  test("programs are listed in order", () => {
    const res = c("journalctl -n 5 --no-pager | grep x | wc -l");
    expect(res.programs).toEqual(["journalctl", "grep", "wc"]);
  });
  test("matchedRules names the allow rules used", () => {
    const res = c("ls | grep x");
    expect(res.matchedRules).toEqual(["ls", "grep"]);
  });
  test("wrapped command is included in programs", () => {
    const res = c("sudo rm -rf /tmp/x");
    expect(res.programs).toContain("sudo");
    expect(res.programs).toContain("rm");
  });
});

describe("PowerShell read-only", () => {
  const rows: Row[] = [
    ["Get-Service", "powershell", "allow"],
    ["Get-Process", "powershell", "allow"],
    ["Get-ChildItem C:\\logs", "powershell", "allow"],
    ["Get-Content C:\\logs\\app.log", "powershell", "allow"],
    ["Get-WinEvent -MaxEvents 50", "powershell", "allow"],
    ["Get-EventLog -LogName System -Newest 10", "powershell", "allow"],
    ["Test-NetConnection example.com -Port 443", "powershell", "allow"],
    ["Test-Connection -Count 2 example.com", "powershell", "allow"],
    ["Resolve-DnsName example.com", "powershell", "allow"],
    ["ipconfig /all", "powershell", "allow"],
    ["ping -n 2 example.com", "powershell", "allow"],
    ["nslookup example.com", "powershell", "allow"],
    ["tracert example.com", "powershell", "allow"],
    ["whoami", "powershell", "allow"],
    ["hostname", "powershell", "allow"],
    ["systeminfo", "powershell", "allow"],
    ["tasklist", "powershell", "allow"],
    ["netstat -an", "powershell", "allow"],
    ["sc.exe query wuauserv", "powershell", "allow"],
    ["wmic cpu get name", "powershell", "allow"],
    ["repadmin /replsummary", "powershell", "allow"],
    ["dcdiag", "powershell", "allow"],
    ["gpresult /r", "powershell", "allow"],
    ["nltest /dsgetdc:contoso", "powershell", "allow"],
  ];
  test.each(rows)("%s", (cmd, shell, want) => {
    expect(c(cmd, shell).decision).toBe(want);
  });
});

describe("PowerShell pipelines, aliases and case-insensitivity", () => {
  const rows: Row[] = [
    ["Get-Service | Where-Object { $_.Status -eq 'Running' }", "powershell", "allow"],
    ["Get-Service | Sort-Object Status | Format-Table", "powershell", "allow"],
    ["Get-Process | Select-Object Name, CPU", "powershell", "allow"],
    ["Get-Process | Measure-Object", "powershell", "allow"],
    ["gci | ? { $_.Length -gt 100 }", "powershell", "allow"],
    ["ps | sort CPU | select -First 5", "powershell", "allow"],
    ["gsv | where { $_.Status -eq 'Stopped' }", "powershell", "allow"],
    ["get-service", "powershell", "allow"],
    ["GET-SERVICE", "powershell", "allow"],
    ["Get-Content log.txt | Select-String error", "powershell", "allow"],
    ["cat log.txt | sls error", "powershell", "allow"],
    ["dir | ft Name", "powershell", "allow"],
  ];
  test.each(rows)("%s", (cmd, shell, want) => {
    expect(c(cmd, shell).decision).toBe(want);
  });
});

describe("PowerShell unsafe and mutating commands ask", () => {
  const rows: Row[] = [
    ["Get-Service | Stop-Service", "powershell", "ask"],
    ["Get-ChildItem | ForEach-Object { Stop-Service $_ }", "powershell", "ask"],
    ["Get-Service | ForEach-Object { Restart-Service $_ }", "powershell", "ask"],
    ["Stop-Service wuauserv", "powershell", "ask"],
    ["Restart-Service nginx", "powershell", "ask"],
    ["Remove-Item C:\\temp\\file.txt", "powershell", "ask"],
    ["Set-Service -Name x -Status Stopped", "powershell", "ask"],
    ["Invoke-Expression $code", "powershell", "ask", "runs code"],
    ["iex (Get-Content s.ps1)", "powershell", "ask"],
    ["Invoke-Command -ScriptBlock { Get-Process }", "powershell", "ask"],
    ["Start-Process notepad", "powershell", "ask"],
    ["Get-Content secrets > out.txt", "powershell", "ask", "`>` needs approval"],
    ["Get-Process >> log.txt", "powershell", "ask", "`>` needs approval"],
    ["& $cmd", "powershell", "ask"],
    ["& 'C:\\tool.exe'", "powershell", "ask"],
    ["$cmd = 'Get-Service'; & $cmd", "powershell", "ask"],
    ["Get-Credential", "powershell", "ask", "secret"],
    ["Get-Content C:\\keys\\id_rsa", "powershell", "ask", "sensitive"],
    ["Get-Content app.env", "powershell", "ask", "sensitive"],
    ["Get-Process $(Stop-Service x)", "powershell", "ask"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

// A filter block looks read-only, but a .NET method or a property assignment inside it changes
// the objects it receives: these passed without asking before 2026-10-05.
describe("PowerShell methods and assignments inside filter blocks ask", () => {
  const rows: Row[] = [
    ["Get-Service Spooler | ForEach-Object { $_.Stop() }", "powershell", "ask", ".NET method"],
    ["Get-Service Spooler | % { $_.Stop() }", "powershell", "ask", ".NET method"],
    ["Get-Process notepad | ForEach-Object { $_.Kill() }", "powershell", "ask", ".NET method"],
    ["Get-ChildItem C:\\temp | ForEach-Object { $_.Delete() }", "powershell", "ask"],
    ["Get-Service | Where-Object { $_.Stop() }", "powershell", "ask", ".NET method"],
    ["Get-Service | ? { $_.Stop() -or $true }", "powershell", "ask", ".NET method"],
    ["Get-Service | Where-Object { $_.Status -eq $_.Stop() }", "powershell", "ask"],
    ["Get-Process | Where-Object { $_.Kill(); $true }", "powershell", "ask"],
    ["Get-ChildItem | ForEach-Object { $_.IsReadOnly = $false }", "powershell", "ask", "assigns"],
    ["Get-ChildItem | ForEach-Object { $_.IsReadOnly=$false }", "powershell", "ask", "assigns"],
    ["Get-Service | ForEach-Object { $x = Stop-Service $_ }", "powershell", "ask"],
    ["Get-ChildItem | ForEach-Object { $_.Attributes += 'Hidden' }", "powershell", "ask"],
    ["Get-Service | ForEach-Object Stop", "powershell", "ask", "member by name"],
    ["Get-Service Spooler | ForEach-Object -MemberName Stop", "powershell", "ask", "member"],
    ["Get-Service Spooler | % Stop", "powershell", "ask", "member by name"],
    ["(Get-Service Spooler).Stop()", "powershell", "ask", ".NET method"],
    ["[System.IO.File]::Delete('C:\\x.txt')", "powershell", "ask", ".NET method"],
    ["Get-Service | ForEach-Object { $_.Name }", "powershell", "allow"],
    ["Get-Service | ForEach-Object -Process { $_.Name }", "powershell", "allow"],
    ["Get-Service | Where-Object { $_.Name -like 'a=b*' }", "powershell", "allow"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

// Since 2026-10-11 a PowerShell line is read as a script: variables, expressions, if/foreach/try,
// hashtables and the functions it defines. What only reads runs; what changes something has a
// type that can be approved "always"; what is still not read asks once.
describe("PowerShell scripts", () => {
  const queue = [
    '"--- Job queue ---"',
    "$files = Get-ChildItem 'C:\\ProgramData\\App\\Jobs' -Filter *.job -ErrorAction SilentlyContinue",
    '"Total: " + $files.Count',
    "foreach ($f in $files) {",
    "  try {",
    "    [xml]$x = (Get-Content -Raw -Encoding UTF8 $f.FullName).TrimStart([char]0xFEFF)",
    '    "{0}`t{1}`tStarted={2}" -f $f.Name, $x.Job.Status.Name, $x.Job.Status.Started',
    '  } catch { "{0}`tREAD ERROR: {1}" -f $f.Name, $_.Exception.Message }',
    "}",
  ].join("\n");
  const folders = [
    "$p = 'C:\\Program Files\\App\\Output'",
    "$all = Get-ChildItem $p -Directory -ErrorAction Stop",
    "$from = Get-Date '2026-08-01'; $to = Get-Date '2026-09-01'",
    "$old = $all | Where-Object { $_.LastWriteTime -ge $from -and $_.LastWriteTime -lt $to }",
    "$bytes = 0; $count = 0",
    "foreach ($d in $old) { $f = Get-ChildItem $d.FullName -Recurse -File -Force; $count += $f.Count; $bytes += ($f | Measure-Object Length -Sum).Sum }",
    '"Folders: " + $all.Count',
    '"Space: {0:N2} GB" -f ($bytes/1GB)',
    "$all | Sort-Object CreationTime | Select-Object -First 5 Name, CreationTime | Format-Table -AutoSize",
    '$v = Get-PSDrive C; "Free {0:N1} GB of {1:N1} GB" -f ($v.Free/1GB), (($v.Used+$v.Free)/1GB)',
  ].join("\n");
  const disks = [
    "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, @{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,2)}}, @{n='SizeGB';e={[math]::Round($_.Size/1GB,2)}} | Format-Table -AutoSize",
    'try { Get-CimInstance Win32_ShadowCopy -ErrorAction Stop | Measure-Object | Select-Object Count } catch { "ShadowCopy: " + $_.Exception.Message }',
    "(Get-CimInstance Win32_OperatingSystem).Caption",
    "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -ErrorAction SilentlyContinue).HibernateEnabled",
  ].join("\n");
  const size = [
    "function Get-Size([string]$path) {",
    "  $sum = [int64]0",
    "  $stack = New-Object System.Collections.Stack",
    "  $stack.Push((New-Object System.IO.DirectoryInfo $path))",
    "  while ($stack.Count -gt 0) {",
    "    $d = $stack.Pop()",
    "    try { foreach ($f in $d.GetFiles()) { $sum += $f.Length } } catch {}",
    "    try { foreach ($s in $d.GetDirectories()) { if (-not ($s.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $stack.Push($s) } } } catch {}",
    "  }",
    "  $sum",
    "}",
    "foreach ($root in 'C:\\Users\\app','C:\\Data') {",
    '  "--- $root ---"',
    "  if (Test-Path $root) {",
    "    Get-ChildItem $root -Directory -Force | ForEach-Object { [pscustomobject]@{ Folder = $_.Name; GB = [math]::Round((Get-Size $_.FullName)/1GB,2); Changed = $_.LastWriteTime.ToString('yyyy-MM-dd') } } | Sort-Object GB -Descending | Format-Table -AutoSize",
    "  }",
    "}",
  ].join("\n");
  const cleanup = [
    "$del = 0; $err = 0",
    "foreach ($f in Get-ChildItem 'C:\\ProgramData\\App\\Jobs' -Filter *.job) {",
    "  [xml]$x = (Get-Content -Raw -Encoding UTF8 $f.FullName).TrimStart([char]0xFEFF)",
    "  if ($x.Job.Status.Name -eq 'Ready') {",
    '    try { Remove-Item $f.FullName -Force -ErrorAction Stop; $del++ } catch { $err++; "ERROR $($f.Name): $($_.Exception.Message)" }',
    "  }",
    "}",
    '"Deleted: $del  Errors: $err"',
  ].join("\n");
  const stop = [
    "$busy = @()",
    "foreach ($f in Get-ChildItem 'C:\\ProgramData\\App\\Jobs' -Filter *.job) {",
    '  if ($f.Length -gt 0) { $busy += "$($f.Name)" }',
    "}",
    'if ($busy.Count -gt 0) { "Jobs still running:"; $busy; exit 1 }',
    "Stop-Service -Name 'App Server' -Force -ErrorAction Stop",
    "(Get-Service -Name 'App Server').Status",
  ].join("\n");
  const move = [
    "$dst = 'D:\\Archive\\Installers'",
    "New-Item -ItemType Directory -Path $dst -Force | Out-Null",
    "Get-ChildItem C:\\ -File -Filter 'App*.msi' | Where-Object { $_.Name -notlike '*4.13*' } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $dst -Force; 'moved: ' + $_.Name }",
  ].join("\n");
  const robocopy = [
    "robocopy C:\\Backup D:\\Archive\\Backup /E /MOVE /R:1 /W:1 /NP",
    "if ($LASTEXITCODE -lt 8) { exit 0 } else { exit 1 }",
  ].join("\n");

  // [command, decision, the types it asks for, whether it can be approved only once]
  const rows: [string, "allow" | "ask", string[], boolean][] = [
    [queue, "allow", [], false],
    [folders, "allow", [], false],
    [disks, "allow", [], false],
    [size, "ask", ["New-Object"], false],
    [cleanup, "ask", ["Remove-Item"], false],
    [stop, "ask", ["Stop-Service"], false],
    [move, "ask", ["New-Item", "Move-Item"], false],
    [robocopy, "ask", ["robocopy"], false],
    ['"--- header ---"', "allow", [], false],
    ["'plain text'", "allow", [], false],
    ["$x = 5; $x++; $x += 2; $x -= 1; $x", "allow", [], false],
    ["$x = 1 # a comment", "allow", [], false],
    ["if ($true) { 'a' }\nelseif ($false) { 'b' }\nelse { 'c' }", "allow", [], false],
    ["$i = 0; do { $i++ } while ($i -lt 3)", "allow", [], false],
    ["for ($i = 0; $i -lt 3; $i++) { Get-Date }", "allow", [], false],
    ["$p = 'C:\\x'; Test-Path($p)", "allow", [], false],
    ["(Get-Date).AddDays(-7).ToString('yyyy-MM-dd')", "allow", [], false],
    ["[datetime]::Now.AddHours(-1)", "allow", [], false],
    ["[string]::Join(', ', (Get-Service | Select-Object -First 3).Name)", "allow", [], false],
    ['"Name: $((Get-Service Spooler).Name) ok"', "allow", [], false],
    ['@"\nTotal: $((Get-ChildItem C:\\).Count)\n"@', "allow", [], false],
    ["Get-Service |\n  Where-Object { $_.Status -eq 'Running' }", "allow", [], false],
    ["Get-Service | foreach { $_.Name }", "allow", [], false],
    ["$env:COMPUTERNAME; $script:total", "allow", [], false],
    ['throw "stop here"', "allow", [], false],
    ["Start-Sleep -Seconds 5; Get-Service Spooler", "allow", [], false],
    ["Join-Path C:\\x y | Split-Path -Leaf", "allow", [], false],
    ["$null = Get-Date", "allow", [], false],
    ["$s = 'a,b'.Split(',') -join ';'; $s.Trim()", "allow", [], false],
    ["1..5 | ForEach-Object { $_ * 2 }", "allow", [], false],
    ["Get-Item . | Select-Object FullName", "allow", [], false],
    // A command hidden in an expression is a piece like any other.
    ['"$(Remove-Item C:\\x.txt)"', "ask", ["Remove-Item"], false],
    ['@"\n " $(Remove-Item C:\\x.txt) "\n"@', "ask", ["Remove-Item"], false],
    ["$x = Remove-Item C:\\x.txt", "ask", ["Remove-Item"], false],
    ["$x=Remove-Item C:\\x.txt", "ask", ["Remove-Item"], false],
    ["$a = $b = Remove-Item C:\\x.txt", "ask", ["Remove-Item"], false],
    ["5 + ($x = Stop-Service Spooler)", "ask", ["Stop-Service"], false],
    ["[pscustomobject]@{ A = (Remove-Item C:\\x.txt) }", "ask", ["Remove-Item"], false],
    ["$h = @{ A = { Stop-Service Spooler } }", "ask", ["Stop-Service"], false],
    ["if ((Stop-Service Spooler)) { 'x' }", "ask", ["Stop-Service"], false],
    ["foreach ($s in (Restart-Service Spooler)) { $s }", "ask", ["Restart-Service"], false],
    ["foreach { Stop-Service Spooler }", "ask", ["Stop-Service"], false],
    ["while ($true) { Stop-Service Spooler; break }", "ask", ["Stop-Service"], false],
    ["exit (Stop-Service Spooler)", "ask", ["Stop-Service"], false],
    ["function Get-Info { Stop-Service Spooler }\nGet-Info", "ask", ["Stop-Service"], false],
    ['"text" > C:\\out.txt', "ask", [">"], false],
    ["7z x archive.zip", "ask", ["7z"], false],
    // What is still not read asks once.
    ["$p = Get-Process notepad; $p.Kill()", "ask", [], true],
    ["$f = Get-Item C:\\x.txt; $f.Delete()", "ask", [], true],
    ["$list = New-Object System.Collections.ArrayList; $list.Add(1)", "ask", [], true],
    ["$x.ForEach('Kill')", "ask", [], true],
    ["$x.Invoke[int]()", "ask", [], true],
    ["$m = 'Kill'; $p.$m()", "ask", [], true],
    ["[System.IO.File]::WriteAllText('C:\\x.txt', 'y')", "ask", [], true],
    ["[scriptblock]::Create('Remove-Item C:\\x.txt')", "ask", [], true],
    ["'Remove-Item C:\\x.txt' -as [scriptblock]", "ask", [], true],
    ["[Environment]::SetEnvironmentVariable('A', 'b')", "ask", [], true],
    ["$t = 'System.IO.File'; $t::Delete('C:\\x.txt')", "ask", [], true],
    ["$f = Get-Item C:\\x.txt; $f.IsReadOnly = $false", "ask", [], true],
    ["$h = @{}; $h['k'] = 1", "ask", [], true],
    ["$env:PATH = 'C:\\tools'", "ask", [], true],
    ["$PSDefaultParameterValues = @{ '*:Force' = $true }", "ask", [], true],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: PowerShell's ${…}, not JS.
    ["${C:\\temp\\x.txt} = 'data'", "ask", [], true],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: PowerShell's ${…}, not JS.
    ["${C:\\keys\\id_rsa}", "ask", [], true],
    ["$function:prompt", "ask", [], true],
    ["foreach ($_ in 1..3) { $_ }", "ask", [], true],
    ["$sb = { Get-Date }; & $sb", "ask", [], true],
    ["$sb = { Get-Date }; . $sb", "ask", [], true],
    ["$sb = { Remove-Item C:\\x.txt }; $sb.Invoke()", "ask", [], true],
    ["switch ($x) { 1 { 'one' } }", "ask", [], true],
    ["if ($true) { function Inner { 'x' } }", "ask", [], true],
    ["$p = 'C:\\keys\\id_rsa'; Get-Content $p", "ask", [], true],
    ["$c = Get-Credential", "ask", [], true],
    ["Get-Date; cmd /c dir C:\\", "ask", [], true],
    ["$s = 'Get-Date'; Invoke-Expression $s", "ask", [], true],
    ["Get-Service | $x", "ask", [], true],
    ["$x = ", "ask", [], true],
    ["if ($true) 'x'", "ask", [], true],
    ["try { Get-Date }", "ask", [], true],
    ["function del { 'x' }\ndel C:\\x.txt", "ask", [], true],
    ["1.exe /s", "ask", ["1"], false],
    ["New-Alias Get-Data Remove-Item; Get-Data C:\\x.txt", "ask", [], true],
    ["Import-Module C:\\mod.psm1; Get-Thing", "ask", [], true],
    [`${"(".repeat(60)}1${")".repeat(60)}`, "ask", [], true],
  ];
  test.each(rows)("%s", (cmd, want, types, onceOnly) => {
    const res = c(cmd, "powershell");
    expect(res.decision).toBe(want);
    if (want === "ask") {
      expect(res.onceOnly).toBe(onceOnly);
      if (!onceOnly) expect(res.types).toEqual(types);
    }
  });

  test("a script runs once its types are approved", () => {
    const ps = approvals("powershell", ["Remove-Item"]);
    expect(c(cleanup, "powershell", ps).decision).toBe("allow");
  });

  test("a function the script defines still meets the deny rules", () => {
    const res = c("function Format-Volume { 'x' }\nFormat-Volume -DriveLetter D", "powershell");
    expect(res.decision).toBe("deny");
  });
});

describe("PowerShell deny rules", () => {
  const rows: Row[] = [
    ["Format-Volume -DriveLetter D", "powershell", "deny"],
    ["Clear-Disk -Number 1", "powershell", "deny"],
    ["diskpart", "powershell", "deny"],
    ["bcdedit /delete '{current}'", "powershell", "deny"],
    ["cipher /w:C", "powershell", "deny"],
    ["vssadmin delete shadows /all", "powershell", "deny"],
    ["wevtutil cl Security", "powershell", "deny", "audit"],
    ["Remove-Item C:\\ -Recurse", "powershell", "deny"],
    ["Remove-ADDomain -Identity contoso", "powershell", "deny"],
    ["Get-Service | Format-Volume", "powershell", "deny"],
  ];
  test.each(rows)("%s", (cmd, shell, want, frag) => {
    const res = c(cmd, shell);
    expect(res.decision).toBe(want);
    if (frag) expect(res.reason).toContain(frag);
  });
});

describe("edge cases", () => {
  test("empty command asks", () => {
    expect(c("").decision).toBe("ask");
  });
  test("whitespace only asks", () => {
    expect(c("   ").decision).toBe("ask");
  });
  test("comment only asks", () => {
    expect(c("# just a comment").decision).toBe("ask");
  });
  test("trailing comment is ignored", () => {
    expect(c("ls -la # list files").decision).toBe("allow");
  });
  test("unterminated quote asks", () => {
    expect(c('echo "unterminated').decision).toBe("ask");
  });
  test("PowerShell unterminated block asks", () => {
    expect(c("Get-Service | ForEach-Object { Stop-Service", "powershell").decision).toBe("ask");
  });
  test("deny beats not-in-allowlist ordering", () => {
    // mkfs is both not allowlisted and a deny rule: deny wins.
    expect(c("mkfs.ext4 /dev/sdb").decision).toBe("deny");
  });
});

describe("performance", () => {
  test("classifies 10k commands in under a second", () => {
    const samples = [
      "journalctl -n 50 --no-pager | grep -i error",
      "sudo rm -rf /tmp/x",
      "Get-Service | Where-Object { $_.Status -eq 'Running' }",
      "rm -rf /",
      "for i in a b c; do cat $i; done",
    ];
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const sample = samples[i % samples.length];
      if (sample === undefined) continue;
      const shell: ShellKind = sample.startsWith("Get-") ? "powershell" : "posix";
      classifyCommand(sample, shell, { mode: "ask" });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});
