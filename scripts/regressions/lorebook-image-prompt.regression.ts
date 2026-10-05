import assert from "node:assert/strict";
import {
  BaseLLMProvider,
  LLMHttpError,
  type ChatMessage,
  type ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import { withLorebookImageCompatibility } from "../../packages/server/src/services/llm/lorebook-image-provider.js";
import { appendLorebookImageMessages } from "../../packages/server/src/services/generation/lorebook-image-prompt.js";
import {
  discardLorebookImage,
  saveLorebookImage,
} from "../../packages/server/src/services/lorebook/lorebook-images.js";
import { processActivatedEntries } from "../../packages/server/src/services/lorebook/prompt-injector.js";
import {
  scopeLorebookScanResultToCharacterContext,
  resolveBudgetAndRecursivelyActivateLorebookEntries,
} from "../../packages/server/src/services/lorebook/index.js";
import { createLorebookEntrySchema, type LorebookEntry, type ChatMLMessage } from "../../packages/shared/dist/index.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jX8AAAAASUVORK5CYII=",
  "base64",
);
const image = { ...(await saveLorebookImage(png)), caption: "Blue coat" };
const makeEntry = (id: string, overrides: Partial<LorebookEntry> = {}) =>
  ({
    ...createLorebookEntrySchema.parse({
      lorebookId: "book",
      name: id,
      content: `Text ${id}`,
      keys: ["wardrobe"],
      images: [image],
    }),
    id,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  }) as LorebookEntry;
const entry = makeEntry("outfit");
const activation = { entry, matchedKeys: ["wardrobe"], activationSources: ["keyword" as const], injectionOrder: 100 };
assert.equal(
  processActivatedEntries([activation], 1).imageEntries,
  undefined,
  "budget-rejected entries carry no images",
);
const textOnly = processActivatedEntries([activation], 50);
assert.equal(textOnly.totalEntries, 1, "entry text that fits the budget survives when its images do not");
assert.equal(textOnly.imageEntries, undefined, "over-budget images are dropped before the entry text");
const recursive = resolveBudgetAndRecursivelyActivateLorebookEntries(
  [{ role: "user", content: "wardrobe" }],
  [
    makeEntry("starter", { content: "recur-trigger", order: 0, preventRecursion: false }),
    makeEntry("later", {
      keys: ["recur-trigger"],
      content: "The queen guards the northern gate. ".repeat(15),
      order: 1,
      images: [],
    }),
  ],
  { scanDepth: 2 },
  2,
  new Map([["book", { name: "Book", tokenBudget: 1000, entryLimit: 100 }]]),
  300,
  100,
);
assert.deepEqual(
  recursive.map(({ entry }) => entry.id),
  ["starter", "later"],
);
assert.deepEqual(recursive[0]!.entry.images, [], "optional images cannot displace affordable recursive text");
const processed = processActivatedEntries([activation], 500);
assert.equal(processed.imageEntries?.length, 1);
assert.ok(processed.totalTokensEstimate >= 256, "images contribute to budget estimates");
const messages: ChatMLMessage[] = [
  { role: "system", content: processed.worldInfoBefore },
  { role: "user", content: "wardrobe", contextKind: "history" },
];
const urls = new Set<string>();
await appendLorebookImageMessages(messages, processed.imageEntries, { rememberImage: (url) => urls.add(url) });
assert.equal(messages[1]?.role, "user");
assert.deepEqual(messages[1]?.images, [...urls]);
assert.match(messages[1]!.content, /outfit.*\nReference 1: Blue coat/s);
assert.equal(messages[2]?.content, "wardrobe");
const outletMessages: ChatMLMessage[] = [{ role: "user", content: entry.content, contextKind: "prompt" }];
await appendLorebookImageMessages(outletMessages, [{ ...processed.imageEntries![0]!, position: 7 }]);
assert.equal(outletMessages.length, 1, "unused outlet does not leak images");
await appendLorebookImageMessages(outletMessages, [
  { ...processed.imageEntries![0]!, position: 7, content: "", outletUsed: true },
]);
assert.equal(outletMessages.length, 2, "used images-only outlet sends its references");
const prefilled: ChatMLMessage[] = [
  { role: "system", content: processed.worldInfoBefore, contextKind: "prompt" },
  { role: "assistant", content: "Prefill" },
];
await appendLorebookImageMessages(prefilled, processed.imageEntries);
assert.equal(prefilled.at(-1)?.content, "Prefill", "references never follow an assistant prefill");
const scan = {
  ...processed,
  activatedEntryIds: [entry.id],
  activatedEntries: [
    {
      id: entry.id,
      content: entry.content,
      matchedKeys: ["wardrobe"],
      activationSources: ["keyword" as const],
      matchType: "keyword" as const,
    },
  ],
  budgetSkippedEntries: [],
};
const privateEntry = { ...entry, characterFilterMode: "include" as const, characterFilterIds: ["alice"] };
assert.deepEqual(
  scopeLorebookScanResultToCharacterContext(scan, [privateEntry], { characterId: "bob" }).imageEntries,
  [],
  "responder-filtered entries carry no images",
);

class FakeProvider extends BaseLLMProvider {
  requests: ChatMessage[][] = [];
  error: Error | null = new LLMHttpError("This model does not support image inputs", { status: 400 });
  outputBeforeError = false;
  constructor() {
    super("", "");
  }
  async *chat(input: ChatMessage[], _options: ChatOptions) {
    this.requests.push(input);
    if (input.some((m) => m.images?.some((url) => urls.has(url))) && this.error) {
      if (this.outputBeforeError) yield "partial";
      throw this.error;
    }
    yield "ok";
  }
}
const options = { model: "text-only" };
const fake = new FakeProvider();
let notices = 0;
const wrapped = withLorebookImageCompatibility(fake, urls, () => notices++);
let response = "";
for await (const token of wrapped.chat(messages, options)) response += token;
assert.equal(response, "ok");
assert.equal(fake.requests.length, 2);
assert.equal(fake.requests[1]![1]!.images, undefined);
assert.match(fake.requests[1]![1]!.content, /Blue coat/);
assert.equal(notices, 1);
await wrapped.chatComplete(
  [...messages, { role: "user", content: "attachment", images: ["data:image/png;base64,dXNlcg=="] }],
  options,
);
assert.deepEqual(
  fake.requests.at(-1)!.at(-1)!.images,
  ["data:image/png;base64,dXNlcg=="],
  "unrelated chat images preserved",
);
const identical = new FakeProvider();
await assert.rejects(async () => {
  const wrapped = withLorebookImageCompatibility(identical, urls, () => assert.fail(), urls);
  await wrapped.chatComplete(
    [...messages, { role: "user", content: "Same chat attachment", images: [...urls] }],
    options,
  );
}, /not support/);
assert.equal(
  identical.requests.length,
  1,
  "identical chat attachments must never be silently stripped as lorebook references",
);
const rejected = new FakeProvider();
rejected.error = new LLMHttpError("Rate limited image model", { status: 429 });
await assert.rejects(async () => {
  for await (const _ of withLorebookImageCompatibility(rejected, urls, () => assert.fail()).chat(messages, options)) {
    /* consume */
  }
}, /Rate limited/);
assert.equal(rejected.requests.length, 1, "non-compatibility errors do not retry");
const partial = new FakeProvider();
partial.outputBeforeError = true;
await assert.rejects(async () => {
  for await (const _ of withLorebookImageCompatibility(partial, urls, () => assert.fail()).chat(messages, options)) {
    /* consume */
  }
}, /not support/);
assert.equal(partial.requests.length, 1, "streamed output must never be replayed");
await discardLorebookImage(image);
console.info("Lorebook image prompt regressions passed");
