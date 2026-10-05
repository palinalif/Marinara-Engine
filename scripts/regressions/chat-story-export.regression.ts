import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-chat-story-export-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

try {
  const {
    describeTranscriptDateRange,
    escapeHtml,
    isStoryTranscriptMessage,
    renderStoryInline,
    renderTranscriptHtml,
    renderTranscriptMarkdown,
  } = await import("../../packages/server/src/services/chat-insights/transcript-document.js");
  const { readSmallAvatarDataUri } =
    await import("../../packages/server/src/services/chat-insights/transcript-avatars.js");

  // Visibility: hidden, command-only, private-only, system and blank turns are left out.
  const visible = (role: string, content: string, extra: Record<string, unknown> = {}) =>
    isStoryTranscriptMessage({ role, content, extra });
  assert.equal(visible("user", "hi"), true);
  assert.equal(visible("narrator", "The wind."), true);
  assert.equal(visible("system", "setup"), false);
  assert.equal(visible("user", "   "), false);
  assert.equal(visible("assistant", "x", { hiddenFromUser: true }), false);
  assert.equal(visible("assistant", "x", { commandOnly: true }), false);
  assert.equal(visible("assistant", "x", { roleplayPrivateOnly: true }), false);
  assert.equal(visible("assistant", "x", { hiddenFromAI: true }), true, "AI-hidden turns are still part of the story");

  // HTML safety: content is escaped before the emphasis subset is applied.
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(
    renderStoryInline("*waves* and **bold** `code`"),
    "<em>waves</em> and <strong>bold</strong> <code>code</code>",
  );
  assert.equal(renderStoryInline("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(renderStoryInline("2*3*4 snake_case_name"), "2*3*4 snake_case_name", "mid-word markers stay literal");

  const entries = [
    {
      speakerKey: "user",
      speaker: "Alex",
      role: "user",
      content: "Hello <b>there</b>",
      createdAt: "2026-01-02T10:00:00.000Z",
    },
    {
      speakerKey: "character:a",
      speaker: "Ayla",
      role: "assistant",
      content: "*smiles*\n\nSecond paragraph\nwith a break.",
      createdAt: "2026-01-05T10:00:00.000Z",
      thinking: "She is glad.",
    },
  ];
  assert.equal(describeTranscriptDateRange(entries), "2026-01-02 to 2026-01-05");
  assert.equal(describeTranscriptDateRange(entries.slice(0, 1)), "2026-01-02");
  assert.equal(describeTranscriptDateRange([]), "");

  const markdown = renderTranscriptMarkdown({ title: "Moon *Road*", entries });
  assert.ok(markdown.startsWith("# Moon \\*Road\\*\n\n_2026-01-02 to 2026-01-05_\n\n---\n"), markdown);
  assert.ok(markdown.includes("### Alex\n\nHello &lt;b&gt;there&lt;/b&gt;\n"));
  assert.ok(markdown.includes("### Ayla\n\n*smiles*\n\nSecond paragraph\nwith a break.\n"));
  assert.ok(markdown.includes("<details><summary>Thinking</summary>\n\nShe is glad.\n\n</details>"));
  const unsafe = renderTranscriptMarkdown({
    title: "T",
    entries: [
      {
        speakerKey: "n",
        speaker: "N",
        role: "narrator",
        content: '<img src=x onerror="alert(1)"><script>alert(2)</script> & **safe**',
        thinking: '<img src=x onerror="alert(3)"><script>alert(4)</script>',
      },
    ],
  });
  assert.doesNotMatch(unsafe, /<img\b|<script\b/i);
  assert.ok(
    unsafe.includes('&lt;img src=x onerror="alert(1)"&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; **safe**'),
  );
  assert.ok(unsafe.includes('&lt;img src=x onerror="alert(3)"&gt;&lt;script&gt;alert(4)&lt;/script&gt;'));
  assert.ok(markdown.endsWith("\n") && !markdown.endsWith("\n\n"));
  const spilled = renderTranscriptMarkdown({
    title: "T",
    entries: [
      { speakerKey: "n", speaker: "N", role: "narrator", content: "x", thinking: "a </details> b </SUMMARY >" },
    ],
  });
  assert.equal(spilled.match(/<\/details>/gu)?.length, 1, "reasoning cannot close the details block early");
  assert.ok(spilled.includes("a &lt;/details&gt; b &lt;/SUMMARY &gt;"));

  const pixel = "data:image/png;base64,iVBORw0KGgo=";
  const html = renderTranscriptHtml({
    title: "Moon <Road>",
    entries,
    avatars: new Map([
      ["character:a", pixel],
      ["user", "javascript:alert(1)"],
    ]),
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<title>Moon &lt;Road&gt;</title>"));
  assert.ok(html.includes('<p class="range">2026-01-02 to 2026-01-05</p>'));
  assert.ok(html.includes("Hello &lt;b&gt;there&lt;/b&gt;"), "message HTML is escaped");
  assert.ok(html.includes("<p><em>smiles</em></p><p>Second paragraph<br>with a break.</p>"));
  assert.ok(html.includes(`background-image:url("${pixel}")`), "small data URI avatars embed");
  assert.ok(html.includes('<div class="avatar avatar-0" aria-hidden="true"></div>'));
  assert.ok(!html.includes("javascript:"), "non data-URI avatars fall back to an initial");
  assert.ok(html.includes(">A</div>"));
  assert.ok(html.includes("prefers-color-scheme:dark") && html.includes("@media print"));
  assert.ok(!/<script/iu.test(html), "the story page has no scripts");
  assert.ok(!html.includes("—"), "no em dashes in the template");

  const repeatedAvatars = renderTranscriptHtml({
    title: "Long story",
    entries: Array.from({ length: 1000 }, (_, index) => entries[index % entries.length]!),
    avatars: new Map(entries.map((entry) => [entry.speakerKey, pixel])),
  });
  assert.equal(repeatedAvatars.split(pixel).length - 1, 1, "a shared avatar embeds once regardless of turn count");

  // Avatar embedding reads only small files from the avatar folder.
  const avatarRoot = join(root, "avatars");
  mkdirSync(avatarRoot, { recursive: true });
  writeFileSync(join(avatarRoot, "small.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(avatarRoot, "big.png"), Buffer.alloc(200 * 1024));
  writeFileSync(join(avatarRoot, "note.txt"), "x");
  assert.equal(
    await readSmallAvatarDataUri("/api/avatars/file/small.png?v=2", undefined, avatarRoot),
    "data:image/png;base64,AQID",
  );
  assert.equal(await readSmallAvatarDataUri("/api/avatars/file/big.png", undefined, avatarRoot), null);
  assert.equal(await readSmallAvatarDataUri("/api/avatars/file/note.txt", undefined, avatarRoot), null);
  assert.equal(await readSmallAvatarDataUri("/api/avatars/file/..%2Fsecret.png", undefined, avatarRoot), null);
  assert.equal(await readSmallAvatarDataUri("https://example.com/a.png", undefined, avatarRoot), null);
  assert.equal(await readSmallAvatarDataUri(null, undefined, avatarRoot), null);

  // Route: the export endpoint serves both formats from the active swipe and skips hidden turns.
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, messageSwipes, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const db = await createFileNativeDB();
  const at = (day: number) => new Date(Date.UTC(2026, 0, day, 12)).toISOString();
  await db
    .insert(characters)
    .values({ id: "char-a", data: JSON.stringify({ name: "Ayla" }), createdAt: at(1), updatedAt: at(1) });
  await db.insert(chats).values({
    id: "chat-story",
    name: "Moon Road",
    mode: "roleplay",
    characterIds: JSON.stringify(["char-a"]),
    createdAt: at(1),
    updatedAt: at(4),
  });
  await db.insert(messages).values([
    { id: "s0", chatId: "chat-story", role: "system", content: "SYSTEM SETUP", createdAt: at(1) },
    { id: "s1", chatId: "chat-story", role: "user", content: "We ride at dawn.", createdAt: at(2) },
    {
      id: "s2",
      chatId: "chat-story",
      role: "assistant",
      characterId: "char-a",
      content: "Active swipe reply.",
      activeSwipeIndex: 1,
      createdAt: at(3),
    },
    {
      id: "s3",
      chatId: "chat-story",
      role: "assistant",
      characterId: "char-a",
      content: "HIDDEN TURN",
      extra: JSON.stringify({ hiddenFromUser: true }),
      createdAt: at(4),
    },
  ]);
  await db.insert(messageSwipes).values([
    { id: "sw0", messageId: "s2", index: 0, content: "OLD SWIPE", createdAt: at(3) },
    { id: "sw1", messageId: "s2", index: 1, content: "Active swipe reply.", createdAt: at(3) },
  ]);

  const app = Fastify();
  app.decorate("db", db);
  await app.register(chatsRoutes, { prefix: "/api/chats" });
  await app.ready();

  const md = await app.inject({ method: "GET", url: "/api/chats/chat-story/export?format=markdown" });
  assert.equal(md.statusCode, 200);
  assert.match(String(md.headers["content-type"]), /^text\/markdown/u);
  assert.match(String(md.headers["content-disposition"]), /Moon%20Road\.md"/u);
  assert.ok(md.body.startsWith("# Moon Road\n\n_2026-01-02 to 2026-01-03_"), md.body);
  assert.ok(md.body.includes("### Ayla\n\nActive swipe reply."));
  assert.ok(md.body.includes("We ride at dawn."));
  for (const excluded of ["OLD SWIPE", "HIDDEN TURN", "SYSTEM SETUP"]) {
    assert.ok(!md.body.includes(excluded), `markdown export leaves out ${excluded}`);
  }

  const story = await app.inject({ method: "GET", url: "/api/chats/chat-story/export?format=html" });
  assert.equal(story.statusCode, 200);
  assert.match(String(story.headers["content-type"]), /^text\/html/u);
  assert.match(String(story.headers["content-disposition"]), /Moon%20Road\.html"/u);
  assert.ok(story.body.includes("<title>Moon Road</title>"));
  assert.ok(story.body.includes('<span class="name">Ayla</span>'));
  assert.ok(!story.body.includes("HIDDEN TURN") && !story.body.includes("OLD SWIPE"));

  await db.insert(chats).values({
    id: "chat-game-story",
    name: "Game Story",
    mode: "game",
    characterIds: JSON.stringify(["char-a"]),
    createdAt: at(1),
    updatedAt: at(2),
  });
  await db.insert(messages).values({
    id: "game-assistant",
    chatId: "chat-game-story",
    role: "assistant",
    characterId: "char-a",
    content: "The gate opens.",
    createdAt: at(2),
  });
  const gameMarkdown = await app.inject({ method: "GET", url: "/api/chats/chat-game-story/export?format=markdown" });
  assert.equal(gameMarkdown.statusCode, 200);
  assert.ok(gameMarkdown.body.includes("### Narrator\n\nThe gate opens."), "Game assistant turns use the narrator");
  const gameHtml = await app.inject({ method: "GET", url: "/api/chats/chat-game-story/export?format=html" });
  assert.equal(gameHtml.statusCode, 200);
  assert.ok(gameHtml.body.includes('<article class="turn narrator">'));
  assert.ok(gameHtml.body.includes('<span class="name">Narrator</span>'));
  assert.ok(!gameHtml.body.includes('<span class="name">Ayla</span>'));

  const text = await app.inject({ method: "GET", url: "/api/chats/chat-story/export?format=text" });
  assert.ok(text.body.startsWith("Chat: Moon Road"), "existing text export is unchanged");

  await app.close();
  await db._fileStore.close();
  process.stdout.write("chat-story-export regression passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
