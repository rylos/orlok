import { describe, expect, it } from "vitest";
import {
  OutputCap,
  OutputCollector,
  SECRET_MARKER,
  SecretMasker,
  stripAnsi,
  TRUNCATION_MARKER,
} from "./output";

function maskInChunks(secrets: string[], chunks: string[]) {
  const masker = new SecretMasker(secrets);
  return chunks.map((chunk) => masker.push(chunk)).join("") + masker.flush();
}

describe("SecretMasker", () => {
  it("masks a secret inside one chunk", () => {
    expect(maskInChunks(["hunter2"], ["password is hunter2!"])).toBe(
      `password is ${SECRET_MARKER}!`,
    );
  });

  it("masks a secret split across chunk boundaries", () => {
    const chunks = ["pass: hun", "te", "r2 end"];
    expect(maskInChunks(["hunter2"], chunks)).toBe(`pass: ${SECRET_MARKER} end`);
    // Every possible single split point.
    const text = "a hunter2 b hunter2";
    for (let i = 1; i < text.length; i++) {
      expect(maskInChunks(["hunter2"], [text.slice(0, i), text.slice(i)])).toBe(
        `a ${SECRET_MARKER} b ${SECRET_MARKER}`,
      );
    }
  });

  it("masks the base64 forms", () => {
    const secret = "s3cr3t-value";
    const padded = Buffer.from(secret).toString("base64");
    const unpadded = Buffer.from("abcd").toString("base64").replace(/=+$/, "");
    expect(maskInChunks([secret], [`b64=${padded.slice(0, 5)}`, `${padded.slice(5)}.`])).toBe(
      `b64=${SECRET_MARKER}.`,
    );
    expect(maskInChunks(["abcd"], [`x ${unpadded} y`])).toBe(`x ${SECRET_MARKER} y`);
  });

  it("masks lines of multi-line secrets", () => {
    const key = "-----BEGIN KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQC7\n-----END KEY-----";
    expect(maskInChunks([key], ["line AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 shown\n"])).toBe(
      `line ${SECRET_MARKER} shown\n`,
    );
  });

  it("holds back only what could still become a secret", () => {
    const masker = new SecretMasker(["hunter2"]);
    expect(masker.push("hello hu")).toBe("hello ");
    expect(masker.push("go")).toBe("hugo");
    expect(masker.flush()).toBe("");
  });

  it("merges overlapping secrets", () => {
    expect(maskInChunks(["abc", "bcdef"], ["xabcdefy"])).toBe(`x${SECRET_MARKER}y`);
  });

  it("passes text through without secrets", () => {
    expect(maskInChunks([], ["plain"])).toBe("plain");
    expect(maskInChunks([""], ["plain"])).toBe("plain");
  });
});

describe("stripAnsi", () => {
  it("removes colors, cursor moves and OSC titles", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b[2K\x1b[1Gline \x1b]0;title\x07done").text).toBe(
      "red line done",
    );
  });

  it("keeps an unfinished sequence for the next chunk", () => {
    const first = stripAnsi("ok \x1b[3", false);
    expect(first).toEqual({ text: "ok ", rest: "\x1b[3" });
    expect(stripAnsi(`${first.rest}2mgreen`, false).text).toBe("green");
  });

  it("does not let escape codes hide a secret", () => {
    const collector = new OutputCollector({ maxBytes: 1000, secrets: ["hunter2"] });
    collector.write(Buffer.from("pw: hun\x1b[0"), "stdout");
    collector.write(Buffer.from("mter2\n"), "stdout");
    collector.finish();
    expect(collector.value()).toBe(`pw: ${SECRET_MARKER}\n`);
  });
});

describe("OutputCap", () => {
  it("keeps everything under the limit", () => {
    const cap = new OutputCap(100);
    const streamed = cap.append("hello ") + cap.append("world") + cap.finish();
    expect(streamed).toBe("hello world");
    expect(cap.value()).toBe("hello world");
    expect(cap.truncated).toBe(false);
  });

  it("keeps the head and the last 20% with a marker", () => {
    const cap = new OutputCap(100);
    let streamed = "";
    for (let i = 0; i < 50; i++) streamed += cap.append(`${String(i).padStart(4, "0")}\n`);
    streamed += cap.finish();
    const value = cap.value();
    expect(cap.truncated).toBe(true);
    const [head, tail] = value.split(TRUNCATION_MARKER);
    expect(Buffer.byteLength(head as string)).toBe(80);
    expect(Buffer.byteLength(tail as string)).toBe(20);
    expect(tail).toBe("0046\n0047\n0048\n0049\n");
    expect(head?.startsWith("0000\n0001\n")).toBe(true);
    // Streamed output is the head plus the marker, a prefix of the final value.
    expect(streamed).toBe(`${head}${TRUNCATION_MARKER}`);
  });

  it("never splits a multi-byte character", () => {
    const cap = new OutputCap(10);
    cap.append("€€€€€€€€");
    expect(cap.value()).not.toContain("�");
  });
});

describe("OutputCollector", () => {
  it("decodes UTF-8 split across chunks and replaces invalid bytes", () => {
    const collector = new OutputCollector({ maxBytes: 1000, secrets: [] });
    const euro = Buffer.from("€");
    collector.write(euro.subarray(0, 1), "stdout");
    collector.write(Buffer.concat([euro.subarray(1), Buffer.from([0xff, 0x0a])]), "stdout");
    collector.finish();
    expect(collector.value()).toBe("€�\n");
  });
});
