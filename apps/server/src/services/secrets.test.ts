import { describe, expect, it } from "vitest";
import { findLikelySecret, maskLikelySecrets, redactSecrets } from "./secrets";
import { splitIntoParts } from "./wiki-ingest";

describe("findLikelySecret", () => {
  it("finds credentials", () => {
    expect(findLikelySecret("Password: Acme1.")?.kind).toBe("a password or key value");
    expect(findLikelySecret('api_key="abcd1234"')?.kind).toBe("a password or key value");
    expect(findLikelySecret("pwd=Summer2024")?.kind).toBe("a password or key value");
    expect(findLikelySecret("secret: my-shared-value")?.kind).toBe("a password or key value");
    expect(findLikelySecret("key AKIAZPPQA2WOP3QDOFGA")?.kind).toBe("an AWS access key");
    expect(findLikelySecret("-----BEGIN OPENSSH PRIVATE KEY-----")?.kind).toBe("a private key");
  });

  it("finds a plain word written down as a password", () => {
    // Weak passwords are still passwords: alone after their label, they read as a credential.
    expect(findLikelySecret("Password: ciaociao")?.kind).toBe("a password or key value");
    expect(findLikelySecret("| utente | admin |\n| password: ciaociao |")?.kind).toBe(
      "a password or key value",
    );
  });

  it("does not take a sentence for a credential", () => {
    // Rejected by Orlok on 21/09/2026, a whole wiki page with it.
    for (const text of [
      "Il logger scrive una riga prima del token: estrarre il JWT con una regex.",
      "token: vedi la nota sul vault",
      "password: la stessa del dominio",
    ]) {
      expect(findLikelySecret(text)).toBeNull();
    }
  });

  it("says where the secret is without repeating it", () => {
    const found = findLikelySecret("# Accessi\n\nUtente sa\nPassword: Acme1.");
    expect(found).toEqual({
      kind: "a password or key value",
      line: 4,
      excerpt: "Password: Ac…",
    });
  });

  it("accepts placeholders and ordinary text", () => {
    for (const text of [
      "sqlcmd -U sa -P <pwd>",
      "Password: [secret removed]",
      "PasswordAuthentication no",
      "The password is in the vault",
      "token bucket on the ISP side",
      "curl -H 'Authorization: Bearer $TOKEN'",
    ]) {
      expect(findLikelySecret(text)).toBeNull();
    }
  });
});

describe("splitIntoParts", () => {
  it("cuts long text at paragraphs", () => {
    const text = ["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n");
    expect(splitIntoParts(text, 130)).toEqual([
      `${"a".repeat(60)}\n\n${"b".repeat(60)}`,
      "c".repeat(60),
    ]);
    expect(splitIntoParts("short", 130)).toEqual(["short"]);
  });
});

describe("redactSecrets", () => {
  const removed = (text: string) => redactSecrets(text);

  it("removes labelled values in the ways notes write them", () => {
    for (const [line, expected] of [
      ["Password: Acme1.", "Password: [secret removed]"],
      ["Pwd: abc", "Pwd: [secret removed]"],
      ["- **API Key:** `k3y-Value`", "- **API Key:** `[secret removed]`"],
      ["# password dominio: Xyz9ab12345!", "# password dominio: [secret removed]"],
      [
        "Password locale di fallback: `S3cret!` (ma password auth spenta)",
        "Password locale di fallback: `[secret removed]` (ma password auth spenta)",
      ],
      [
        'La password degli utenti TERM_X è "Termin4l."',
        'La password degli utenti TERM_X è "[secret removed]"',
      ],
      ["(user: admin, pass: M0nit!)", "(user: admin, pass: [secret removed])"],
      [
        "| Secret Access Key | `wJalrXUtnFEMI/K7MDENG` |",
        "| Secret Access Key | `[secret removed]` |",
      ],
      [
        "MONITOR ups@app03 1 monuser Pw9x slave",
        "MONITOR ups@app03 1 monuser [secret removed] slave",
      ],
      [
        "--header 'Authorization: DeepL-Auth-Key 1a2b3c4d-5e6f:fx'",
        "--header 'Authorization: DeepL-Auth-Key [secret removed]'",
      ],
      ["-A9bCDE1FGhI2", "[secret removed]"],
    ]) {
      expect(removed(line ?? "").text).toBe(expected);
      expect(removed(line ?? "").count).toBe(1);
    }
  });

  it("leaves prose, commands, identifiers and placeholders alone", () => {
    for (const line of [
      "Password: [secret removed]",
      "password: <da chiedere a Luca>",
      "Campi chiave: `idOfferta`, `rifCommerciale`",
      "Reset password di XXX: `docker exec app reset-admin-pwd <nuova>`.",
      "La chiave privata è autorizzata, quindi niente password:",
      "**Attenzione**",
      "**CONFIGURA9**",
      '"20240101_01_offertaFinale_ClienteXY_BOZZA_V2.docx"',
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "token: estrarre il JWT dalla risposta",
    ]) {
      expect(removed(line)).toEqual({ text: line, count: 0 });
    }
  });

  it("does not read across lines or inside code blocks", () => {
    const text =
      "Accedi con la chiave, senza password:\n```bash\nssh root@host\n```\n```\nAbCdEf123!xyz\n```";
    expect(removed(text)).toEqual({ text, count: 0 });
  });
});

// Credentials written inside other text (2026-10-12): environment assignments, connection
// strings and JSON Web Tokens, found alike by the write check, output masking and redaction.
describe("embedded credentials", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

  it("removes the value and keeps what says what it is", () => {
    for (const [text, expected] of [
      ["DB_PASSWORD=Sup3rS3gr3to", "DB_PASSWORD=[secret removed]"],
      [
        'export GITEA__database__PASSWD="abc123def"',
        'export GITEA__database__PASSWD="[secret removed]"',
      ],
      ["MYSQL_ROOT_PASSWORD: rootpw99", "MYSQL_ROOT_PASSWORD: [secret removed]"],
      [
        "DATABASE_URL=postgres://orlok:orl0k-pw@127.0.0.1:5432/orlok",
        "DATABASE_URL=postgres://orlok:[secret removed]@127.0.0.1:5432/orlok",
      ],
      [`Authorization header: Bearer ${jwt}`, "Authorization header: Bearer [secret removed]"],
    ] as const) {
      expect(redactSecrets(text).text).toBe(expected);
      expect(findLikelySecret(text)).not.toBeNull();
      expect(maskLikelySecrets(text)).not.toContain(text.includes(jwt) ? jwt : "pw");
    }
  });

  it("leaves placeholders and addresses without a password alone", () => {
    for (const text of [
      "DB_PASSWORD=<nuova>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
      "DB_PASSWORD=${DB_PASSWORD}",
      "postgres://orlok@127.0.0.1:5432/orlok",
      "https://orlok.example.com/admin",
      "DB_PASSWORD=[secret removed]",
    ]) {
      expect(redactSecrets(text)).toEqual({ text, count: 0 });
      expect(findLikelySecret(text)).toBeNull();
    }
  });
});
