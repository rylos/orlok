import { describe, expect, it } from "vitest";
import { htmlToText, markdownToTelegram } from "./format";

describe("markdownToTelegram", () => {
  it("turns chat Markdown into Telegram HTML", () => {
    const [html] = markdownToTelegram(
      [
        "## Status",
        "",
        "**nginx** is *down* on `web01` <b>, see [docs](https://example.com/a?b=1&c=2).",
        "",
        "- one",
        "  - nested",
        "1. first",
        "",
        "> quoted",
        "",
        "```sh",
        "systemctl status nginx && echo <ok>",
        "```",
      ].join("\n"),
    );
    expect(html).toBe(
      [
        "<b>Status</b>",
        "",
        '<b>nginx</b> is <i>down</i> on <code>web01</code> &lt;b&gt;, see <a href="https://example.com/a?b=1&amp;c=2">docs</a>.',
        "",
        "• one\n   ◦ nested",
        "",
        "1. first",
        "",
        "<blockquote>quoted</blockquote>",
        "",
        '<pre><code class="language-sh">systemctl status nginx &amp;&amp; echo &lt;ok&gt;</code></pre>',
      ].join("\n"),
    );
  });

  it("shows narrow tables as a grid and wide ones as cards", () => {
    const [narrow] = markdownToTelegram(
      "| Host | Disk |\n|---|--:|\n| web01 | 80% |\n| rd01 | 5% |",
    );
    expect(narrow).toBe("<pre>Host  │ Disk\n──────┼─────\nweb01 │  80%\nrd01  │   5%</pre>");
    const [wide] = markdownToTelegram(
      "| Host | Problem | Fix |\n|---|---|---|\n| web01 | the disk is almost full | remove old backups in /var/backups |",
    );
    expect(wide).toBe(
      "<b>web01</b>\n<i>Problem</i>: the disk is almost full\n<i>Fix</i>: remove old backups in /var/backups",
    );
  });

  it("splits long answers between blocks and never inside a tag", () => {
    const paragraph = `**${"word ".repeat(30).trim()}**`;
    const parts = markdownToTelegram(Array(10).fill(paragraph).join("\n\n"), 400);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(400);
      expect(part.split("<b>").length).toBe(part.split("</b>").length);
    }
    const code = markdownToTelegram(`\`\`\`\n${"x<".repeat(500)}\n\`\`\``, 400);
    for (const part of code) {
      expect(part.length).toBeLessThanOrEqual(400);
      expect(part).toMatch(/^<pre><code>.*<\/code><\/pre>$/s);
    }
    expect(htmlToText(code.join(""))).toBe("x<".repeat(500));
  });
});
