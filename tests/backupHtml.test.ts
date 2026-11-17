import { describe, it, expect } from "vitest";
import { renderBackupHtml, renderMarkdown } from "../src/lib/backupHtml.js";
import type { BackupData, BackupMessage } from "../src/lib/backupTypes.js";

function msg(over: Partial<BackupMessage> = {}): BackupMessage {
  return {
    id: "m1",
    authorId: "u1",
    createdAt: "2026-11-17T05:00:00.000Z",
    editedAt: null,
    content: "hello",
    replyTo: null,
    pinned: false,
    embeds: [],
    attachments: [],
    reactions: [],
    stickers: [],
    system: null,
    ...over,
  };
}

function data(messages: BackupMessage[], over: Partial<BackupData> = {}): BackupData {
  return {
    project: "CyBreach",
    dissolvedAt: "2026-11-17T06:30:00.000Z",
    dissolvedBy: "founder#0001",
    authors: {
      u1: { id: "u1", name: "Ravi Kumar", username: "ravi", bot: false, avatar: "data:image/png;base64,AAAA" },
      u2: { id: "u2", name: "Asha", username: "asha", bot: false },
    },
    channels: [{ id: "c1", name: "m1-general", category: "CyBreach M1", kind: "text", messages }],
    ...over,
  };
}

describe("renderMarkdown", () => {
  it("escapes HTML before formatting", () => {
    const out = renderMarkdown(`<script>alert(1)</script> <img src=x onerror="y">`);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;y&quot;");
  });

  it("formats bold, italic, underline, strike, inline code and quotes", () => {
    expect(renderMarkdown("**b**")).toContain("<strong>b</strong>");
    expect(renderMarkdown("*i* and _j_")).toContain("<em>i</em> and <em>j</em>");
    expect(renderMarkdown("__u__")).toContain("<u>u</u>");
    expect(renderMarkdown("~~s~~")).toContain("<s>s</s>");
    expect(renderMarkdown("`**x**`")).toContain("<code>**x**</code>");
    expect(renderMarkdown("> quoted")).toContain("<blockquote>quoted</blockquote>");
  });

  it("keeps code blocks verbatim and escaped", () => {
    const out = renderMarkdown("```js\nconst a = '<b>';\n**no**\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("const a = &#39;&lt;b&gt;&#39;;");
    expect(out).toContain("**no**");
  });

  it("links only http(s) URLs, safely", () => {
    const out = renderMarkdown(`see https://ex.com/a?b=1&c="2" and javascript:alert(1)`);
    expect(out).toContain('<a href="https://ex.com/a?b=1&amp;c=&quot;2&quot;" target="_blank" rel="noopener noreferrer">');
    expect(out).not.toContain('href="javascript');
  });

  it("turns newlines into <br>", () => {
    expect(renderMarkdown("a\nb")).toBe("a<br>b");
  });
});

describe("renderBackupHtml", () => {
  it("renders header with project, counts and who dissolved it", () => {
    const html = renderBackupHtml(data([msg(), msg({ id: "m2" })]));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<title>CyBreach — message backup</title>");
    expect(html).toContain("founder#0001");
    expect(html).toContain("1 channel");
    expect(html).toContain("2 messages");
    expect(html).toContain("m1-general");
    expect(html).toContain("CyBreach M1");
  });

  it("shows avatar image, or initials when there is none", () => {
    const html = renderBackupHtml(data([msg(), msg({ id: "m2", authorId: "u2", createdAt: "2026-11-17T05:01:00.000Z" })]));
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain(">A</div>");
  });

  it("groups consecutive messages by the same author within 7 minutes", () => {
    const html = renderBackupHtml(
      data([
        msg({ id: "a" }),
        msg({ id: "b", createdAt: "2026-11-17T05:03:00.000Z" }),
        msg({ id: "c", createdAt: "2026-11-17T05:20:00.000Z" }),
      ])
    );
    expect(html.match(/class="msg head"/g)?.length).toBe(2);
    expect(html.match(/class="msg cont"/g)?.length).toBe(1);
  });

  it("quotes the replied message, or says it is missing", () => {
    const html = renderBackupHtml(
      data([
        msg({ id: "a", content: "original text" }),
        msg({ id: "b", authorId: "u2", replyTo: "a", content: "answer" }),
        msg({ id: "c", authorId: "u2", replyTo: "gone", content: "orphan" }),
      ])
    );
    expect(html).toMatch(/class="reply"[^]*Ravi Kumar[^]*original text/);
    expect(html).toContain("Original message not found");
  });

  it("shows images inline and other files as chips", () => {
    const html = renderBackupHtml(
      data([
        msg({
          attachments: [
            { name: "shot.png", size: 2048, dataUri: "data:image/png;base64,QQ==" },
            { name: "report.pdf", size: 3 * 1024 * 1024 },
            { name: "big.png", size: 9 * 1024 * 1024, note: "image not saved (over 8 MB)" },
          ],
        }),
      ])
    );
    expect(html).toContain('<img class="att-img" src="data:image/png;base64,QQ==" alt="shot.png"');
    expect(html).toContain("report.pdf");
    expect(html).toContain("3.0 MB");
    expect(html).toContain("image not saved (over 8 MB)");
  });

  it("renders embeds, reactions, pinned, edited and system lines, all escaped", () => {
    const html = renderBackupHtml(
      data([
        msg({
          editedAt: "2026-11-17T05:05:00.000Z",
          pinned: true,
          reactions: [{ emoji: "👍", count: 3 }],
          embeds: [{ title: "<b>T</b>", description: "desc", color: 0xff0000, fields: [{ name: "F", value: "V" }] }],
        }),
        msg({ id: "s", system: "Ravi Kumar pinned a message", content: "" }),
      ])
    );
    expect(html).toContain("(edited)");
    expect(html).toContain("Pinned");
    expect(html).toContain("👍");
    expect(html).toContain(">3<");
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).toContain("border-left-color:#ff0000");
    expect(html).toContain('class="system"');
  });

  it("escapes channel, author and project names", () => {
    const d = data([msg()], { project: `<x>"p"` });
    d.authors.u1!.name = "<evil>";
    d.channels[0]!.name = "<chan>";
    const html = renderBackupHtml(d);
    expect(html).not.toContain("<evil>");
    expect(html).not.toContain("<chan>");
    expect(html).not.toContain("<x>");
  });

  it("lists threads under their parent channel", () => {
    const d = data([msg()]);
    d.channels.push({ id: "t1", name: "bug-123", category: "CyBreach M1", kind: "thread", parent: "m1-general", messages: [msg({ id: "t" })] });
    const html = renderBackupHtml(d);
    expect(html).toContain("bug-123");
    expect(html).toContain('class="side-item thread"');
  });

  it("says when a channel has no messages", () => {
    const html = renderBackupHtml(data([]));
    expect(html).toContain("No messages in this channel.");
  });
});

describe("review fixes", () => {
  it("keeps trailing markdown and <url> brackets out of links", () => {
    expect(renderMarkdown("**https://x.com/a**")).toContain('<strong><a href="https://x.com/a" target="_blank" rel="noopener noreferrer">https://x.com/a</a></strong>');
    expect(renderMarkdown("<https://x.com/b>")).toContain('href="https://x.com/b"');
    expect(renderMarkdown("see https://x.com/c.")).toContain('href="https://x.com/c"');
  });

  it("notes image download failures in the header", () => {
    const html = renderBackupHtml({ ...data([msg()]), imageFailures: 2 });
    expect(html).toContain("2 images could not be downloaded");
  });
});
