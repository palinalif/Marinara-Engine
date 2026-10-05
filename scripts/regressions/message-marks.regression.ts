import assert from "node:assert/strict";
import {
  MAX_PINNED_CONTEXT_MESSAGES,
  PINNED_CONTEXT_MESSAGE_MARKER,
  applyContextMessageLimitWithPins,
  normalizeMessageMarkPatch,
  stripPrivateMessageNote,
} from "../../packages/shared/src/utils/message-marks.js";
import { appendRoleplayMessageNotes } from "../../packages/server/src/services/generation/roleplay-commands.js";

type Row = { id: string; content: string; extra: string };
const row = (id: string, pinned = false): Row => ({
  id,
  content: `content ${id}`,
  extra: JSON.stringify(pinned ? { pinnedToContext: true } : {}),
});
const history = Array.from({ length: 12 }, (_, index) => row(`m${index + 1}`, [1, 4, 9].includes(index)));

assert.deepEqual(
  applyContextMessageLimitWithPins(history, 4).map((message) => message.id),
  ["m2", "m5", "m9", "m10", "m11", "m12"],
);
const limited = applyContextMessageLimitWithPins(history, 4);
assert.equal(limited[0]!.content, `${PINNED_CONTEXT_MESSAGE_MARKER}\ncontent m2`);
assert.equal(limited[3], history[9], "a pinned message already inside the retained window is unchanged");
assert.equal(history[1]!.content, "content m2", "pin marking must not mutate persisted history");
const manyPins = Array.from({ length: 30 }, (_, index) => row(`p${index}`, true));
assert.equal(applyContextMessageLimitWithPins(manyPins, 5).length, 5 + MAX_PINNED_CONTEXT_MESSAGES);
assert.deepEqual(
  applyContextMessageLimitWithPins(history, 0.5),
  history,
  "a positive fractional limit that floors to zero does not remove the entire history",
);

assert.deepEqual(
  normalizeMessageMarkPatch({ bookmark: true }, () => "2026-09-27T00:00:00.000Z"),
  {
    patch: { bookmark: { label: null, createdAt: "2026-09-27T00:00:00.000Z" } },
  },
);
assert.ok("error" in normalizeMessageMarkPatch({ privateNote: "x".repeat(2001) }));
assert.deepEqual(normalizeMessageMarkPatch({ privateNote: "  " }), { patch: { privateNote: null } });
assert.deepEqual(stripPrivateMessageNote({ other: true, privateNote: "secret" }), { other: true });
assert.deepEqual(stripPrivateMessageNote({ other: true, privateNote: "secret", privateNoteRecipientId: "narrator" }), {
  other: true,
});
assert.deepEqual(normalizeMessageMarkPatch({ privateNoteRecipientId: "narrator" }), {
  patch: { privateNoteRecipientId: "narrator" },
});
assert.deepEqual(normalizeMessageMarkPatch({ privateNoteRecipientId: null }), {
  patch: { privateNoteRecipientId: null },
});
for (const invalid of ["", 7, "x".repeat(201)]) {
  assert.ok("error" in normalizeMessageMarkPatch({ privateNoteRecipientId: invalid }), String(invalid));
}

// A shared note reaches only the chosen character, attached to its own message.
const noteHistory = [
  {
    id: "u1",
    role: "user",
    content: "I open the door.",
    extra: JSON.stringify({ privateNote: "It is a trap.", privateNoteRecipientId: "narrator" }),
  },
  { id: "a1", role: "assistant", content: "The hinge creaks.", extra: { privateNote: "Stays mine." } },
  {
    id: "u2",
    role: "user",
    content: "I step inside.",
    extra: { privateNote: "For Mira.", privateNoteRecipientId: "mira" },
  },
];
const notePrompt = () => [
  { id: "sys", contextKind: "system", content: "Rules." },
  ...noteHistory.map((message) => ({ id: message.id, contextKind: "history", content: message.content })),
];
const narratorPrompt = notePrompt();
assert.equal(appendRoleplayMessageNotes(narratorPrompt, noteHistory, { id: "narrator", kind: "character" }), true);
assert.match(
  narratorPrompt[1]!.content,
  /^I open the door\.\n\n\[The user's private note on this message, shown only to you\]\nIt is a trap\./,
);
assert.equal(narratorPrompt[2]!.content, "The hinge creaks.", "an unshared note stays private");
assert.equal(narratorPrompt[3]!.content, "I step inside.", "another character's note is not shown");
const miraPrompt = notePrompt();
assert.equal(appendRoleplayMessageNotes(miraPrompt, noteHistory, { id: "mira", kind: "character" }), true);
assert.ok(!miraPrompt[1]!.content.includes("It is a trap."));
assert.ok(miraPrompt[3]!.content.includes("For Mira."));
for (const viewer of [null, { id: "narrator", kind: "persona" as const }, { id: "bard", kind: "character" as const }]) {
  const prompt = notePrompt();
  assert.equal(appendRoleplayMessageNotes(prompt, noteHistory, viewer), false);
  assert.deepEqual(prompt, notePrompt(), "no note reaches other viewers");
}

process.stdout.write("Message marks regression passed.\n");
