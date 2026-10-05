// Chat variables: a per-chat {{name}} the user defines in Chat Settings and
// types into a message. Covers the engine lookup order, the guards that keep
// prototype members out of prompts, and the creation-time name rules.
import assert from "node:assert/strict";
import {
  DEFERRED_RELOCATION_CONDITIONAL_TOKEN_RE,
  hasDeferredRelocationConditionals,
  parseDeferredConditionalPayload,
  RESERVED_MACRO_NAMES,
  selectConditionalPayloadBranch,
  resolveMacros,
  validateChatVariableName,
  type MacroContext,
} from "../../packages/shared/src/index.js";

const baseContext = (overrides: Partial<MacroContext> = {}): MacroContext => ({
  user: "Kentaro",
  char: "Pantalone",
  characters: ["Pantalone"],
  variables: {},
  ...overrides,
});

// A name defined in Chat Settings resolves anywhere macros do, including a
// message the user typed.
assert.equal(
  resolveMacros("{{char1}} walks in.", baseContext({ localVariables: { char1: "Mary" } }), {}),
  "Mary walks in.",
);

// Preset variables keep precedence, matching the post-assembly merge.
assert.equal(
  resolveMacros("{{char1}}", baseContext({ variables: { char1: "Preset" }, localVariables: { char1: "Chat" } }), {}),
  "Preset",
);

// Unknown names still survive verbatim.
assert.equal(resolveMacros("{{nope}}", baseContext({ localVariables: { char1: "Mary" } }), {}), "{{nope}}");

// Built-in macros run first, so a chat variable cannot shadow one.
assert.equal(resolveMacros("{{char}}", baseContext({ localVariables: { char: "Wrong" } }), {}), "Pantalone");

// Prototype members are not variables. Before the own-property guard these
// rendered native-code source text into the prompt.
for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
  assert.equal(resolveMacros(`{{${name}}}`, baseContext(), {}), `{{${name}}}`, name);
  assert.equal(
    resolveMacros(`{{${name}}}`, baseContext({ localVariables: {} }), {}),
    `{{${name}}}`,
    `${name} with a chat map`,
  );
}

// A {{setvar}} earlier in the same resolution is visible to a later bare tag,
// and the caller's map keeps the value for the next turn.
const liveVariables: Record<string, string> = {};
assert.equal(
  resolveMacros("{{setvar::char1::Anna}}{{char1}}", baseContext({ localVariables: liveVariables }), {}),
  "Anna",
);
assert.deepEqual(liveVariables, { char1: "Anna" });

// Conditionals read the same map, both as an explicit var: operand and bare.
assert.equal(
  resolveMacros("{{#if var:char1}}yes{{/if}}", baseContext({ localVariables: { char1: "Mary" } }), {}),
  "yes",
);
assert.equal(
  resolveMacros('{{#if char1 == "Mary"}}yes{{else}}no{{/if}}', baseContext({ localVariables: { char1: "Mary" } }), {}),
  "yes",
);

// ── Preset precedence while preset values are still pending ──
// History is resolved before the assembler merges preset values, so a name the
// preset owns must be left alone rather than taking the chat's value: the
// provider-boundary pass, which runs after that merge, fills it in.
const pendingPresetContext = baseContext({
  localVariables: { char1: "Mary" },
  deferredPresetVariableNames: new Set(["char1"]),
});
assert.equal(resolveMacros("{{char1}} walks in.", pendingPresetContext, {}), "{{char1}} walks in.");
assert.equal(
  resolveMacros("{{char2}} walks in.", pendingPresetContext, {}),
  "{{char2}} walks in.",
  "a name no map defines is still left as typed",
);
// A chat variable the preset does not own keeps resolving immediately.
assert.equal(
  resolveMacros(
    "{{mood}}",
    baseContext({ localVariables: { mood: "tense" }, deferredPresetVariableNames: new Set(["char1"]) }),
    {},
  ),
  "tense",
);
// Once the preset value is merged in, it wins and the claim is moot.
assert.equal(
  resolveMacros(
    "{{char1}}",
    baseContext({
      variables: { char1: "Anna" },
      localVariables: { char1: "Mary" },
      deferredPresetVariableNames: new Set(["char1"]),
    }),
    {},
  ),
  "Anna",
);
// A conditional on a claimed name is encoded rather than decided, so it cannot
// contradict the bare tag in the same message. It decodes preset-first later.
const deferredConditional = resolveMacros('{{#if char1 == "Anna"}}PRESET{{else}}CHAT{{/if}}', pendingPresetContext, {});
assert.ok(hasDeferredRelocationConditionals(deferredConditional), "the block must be deferred, not decided");
const mergedContext = baseContext({
  variables: { char1: "Anna" },
  localVariables: { char1: "Mary", char2: "Mary" },
});
const decoded = deferredConditional.replace(DEFERRED_RELOCATION_CONDITIONAL_TOKEN_RE, (_match, encoded: string) => {
  const payload = parseDeferredConditionalPayload(encoded);
  assert.ok(payload, "the payload must survive encoding");
  return resolveMacros(selectConditionalPayloadBranch(payload, mergedContext, { trimResult: false }), mergedContext, {
    trimResult: false,
  });
});
assert.equal(decoded, "PRESET", "the decoded branch reads the preset value");

// Each character's bracket block must retain the pending preset claim too.
const characterBlocks = resolveMacros(
  '[\n{{char}}: {{#if char1 == "Anna"}}PRESET{{else}}CHAT{{/if}}\n]',
  { ...pendingPresetContext, characterProfiles: [{ name: "Pantalone" }, { name: "Dottore" }] },
);
assert.ok(hasDeferredRelocationConditionals(characterBlocks), "character blocks must defer pending preset values");
const decodedBlocks = characterBlocks.replace(DEFERRED_RELOCATION_CONDITIONAL_TOKEN_RE, (_match, encoded: string) => {
  const payload = parseDeferredConditionalPayload(encoded);
  assert.ok(payload);
  return selectConditionalPayloadBranch(payload, mergedContext, { trimResult: false });
});
assert.ok(decodedBlocks.includes("Pantalone: PRESET"));
assert.ok(decodedBlocks.includes("Dottore: PRESET"));
assert.ok(!decodedBlocks.includes("CHAT"));

// The operand may also name the variable inside braces, on either side of the
// comparison — before this was handled, `{{#if {{char1}} == "Anna"}}` was
// decided inline from the chat value while the bare tag beside it read the
// preset's.
const decodeWith = (template: string, ctx: MacroContext) => {
  const resolved = resolveMacros(template, ctx, {});
  if (!hasDeferredRelocationConditionals(resolved)) return { deferred: false, text: resolved };
  const text = resolved.replace(DEFERRED_RELOCATION_CONDITIONAL_TOKEN_RE, (_match, encoded: string) => {
    const payload = parseDeferredConditionalPayload(encoded);
    assert.ok(payload);
    return resolveMacros(selectConditionalPayloadBranch(payload, mergedContext, { trimResult: false }), mergedContext, {
      trimResult: false,
    });
  });
  return { deferred: true, text };
};
const bracedLeft = decodeWith('{{#if {{char1}} == "Anna"}}PRESET{{else}}CHAT{{/if}}', pendingPresetContext);
assert.ok(bracedLeft.deferred, "a braced operand must defer the block");
assert.equal(bracedLeft.text, "PRESET");
const bracedBare = decodeWith("{{#if {{char1}}}}PRESET{{else}}CHAT{{/if}}", pendingPresetContext);
assert.ok(bracedBare.deferred, "a braced truthiness test must defer too");
assert.equal(bracedBare.text, "PRESET");
// A claimed name on the right-hand side defers as well, and then compares
// against the preset value: char2 is Mary, char1 becomes Anna, so no match.
const bracedRight = decodeWith(
  '{{#if char2 == "{{char1}}"}}PRESET{{else}}CHAT{{/if}}',
  baseContext({
    localVariables: { char1: "Mary", char2: "Mary" },
    deferredPresetVariableNames: new Set(["char1"]),
  }),
);
assert.ok(bracedRight.deferred, "a claimed name in the right operand must defer");
assert.equal(bracedRight.text, "CHAT");
// {{getvar}} asks for chat state explicitly, so it is not deferred.
assert.equal(
  decodeWith('{{#if {{getvar::char1}} == "Mary"}}PRESET{{else}}CHAT{{/if}}', pendingPresetContext).deferred,
  false,
  "an explicit chat read stays inline",
);

// `var:` spelling is claimed too, and an unclaimed name is still decided inline.
assert.ok(hasDeferredRelocationConditionals(resolveMacros("{{#if var:char1}}y{{/if}}", pendingPresetContext, {})));
assert.equal(
  resolveMacros(
    "{{#if mood}}has mood{{/if}}",
    baseContext({ localVariables: { mood: "tense" }, deferredPresetVariableNames: new Set(["char1"]) }),
    {},
  ),
  "has mood",
);

// getvar is explicit about reading chat state, so it is unaffected.
assert.equal(resolveMacros("{{getvar::char1}}", pendingPresetContext, {}), "Mary");

// An unset name reads as empty through getvar, unchanged behavior.
assert.equal(resolveMacros("[{{getvar::missing}}]", baseContext({ localVariables: {} }), {}), "[]");

// Bare 21-character identifiers are character references, so they cannot be
// created as variables that would silently remain unresolved in messages.
assert.equal(resolveMacros("{{abcdefghijklmnopqrstu}}", baseContext({
  localVariables: { abcdefghijklmnopqrstu: "unreadable" },
})), "{{abcdefghijklmnopqrstu}}");
assert.equal(validateChatVariableName("abcdefghijklmnopqrstu"), "reserved");
assert.equal(validateChatVariableName("abcdefghijklmnopqrst"), null);
assert.equal(validateChatVariableName("abcdefghijklmnopqrstuv"), null);

// Creation-time name rules.
assert.equal(validateChatVariableName("char1"), null);
assert.equal(validateChatVariableName("_private"), null);
assert.equal(validateChatVariableName("  spaced  "), null, "names are trimmed before validation");
assert.equal(validateChatVariableName(""), "empty");
assert.equal(validateChatVariableName("1char"), "format");
assert.equal(validateChatVariableName("story.day"), "format", "a dotted name could never resolve as a bare tag");
assert.equal(validateChatVariableName("my-var"), "format");
assert.equal(validateChatVariableName("a".repeat(65)), "format");
assert.equal(validateChatVariableName("char"), "reserved");
assert.equal(validateChatVariableName("USER"), "reserved", "built-in passes are case-insensitive");
assert.equal(validateChatVariableName("__proto__"), "reserved", "object members are not variable names");
assert.equal(validateChatVariableName("constructor"), "reserved");
assert.equal(validateChatVariableName("char1", ["char1"]), "duplicate");
assert.equal(validateChatVariableName("char1", ["char2"]), null);

for (const reserved of ["char", "user", "input", "date", "time", "random", "roll", "getvar", "setvar"]) {
  assert.ok(RESERVED_MACRO_NAMES.has(reserved), `${reserved} must be reserved`);
}

console.info("chat variables regressions passed.");
