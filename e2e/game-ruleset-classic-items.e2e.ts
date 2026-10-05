import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { openGame, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * A ruleset's items in a Classic battle (#6905), on screen. The encounter's start works the ruleset's
 * items out from their `use` and keeps the model's guess only for the rest; the Items menu offers the
 * poultice with what it really does and a plain rope as guessed, and leaves the coat out; using the
 * poultice heals by the ruleset's own strength and takes one out of the bag.
 */

/** Ember Roads without the fights it resolves itself (and so without its bestiary), so its battles are
 *  the Engine's own. */
function emberWithoutFights(id: string): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"));
  doc.id = id;
  delete doc.combat;
  doc.catalogs = doc.catalogs.filter((catalog: { holds?: string }) => catalog.holds !== "creatures");
  // Carrying is not what this test is about.
  delete doc.items.carry;
  for (const family of doc.items.currencies ?? []) delete family.perWeight;
  return JSON.stringify(doc);
}

/** A local model whose every answer is the encounter below. No paid provider is called. */
async function encounterModel(blueprint: unknown): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
      // Drain the request.
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "local-proof",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: JSON.stringify(blueprint) }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The model fixture did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

/** What the bags hold, stack by stack. */
async function held(request: APIRequestContext, chatId: string): Promise<Array<[string, number]>> {
  const row = await (await request.get(`/api/chats/${chatId}`)).json();
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return (metadata.gameInventory as Array<{ name: string; quantity: number }>).map((stack) => [
    stack.name,
    stack.quantity,
  ]);
}

test("a Classic battle offers the ruleset's items by their own use, and the poultice heals by its own strength", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const model = await encounterModel({
    party: [{ name: "Hero" }],
    enemies: [{ name: "Guard" }],
    itemEffects: [
      { name: "Rope", target: "enemy", type: "status", description: "Tangles a foe's legs", power: 0.2 },
      { name: "Poultice", target: "enemy", type: "damage", description: "Guessed as a weapon", power: 2 },
      { name: "Leather coat", target: "ally", type: "heal", description: "Guessed as a heal" },
    ],
  });
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: { definition: emberWithoutFights("ember-classic-items-e2e") },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local encounter fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "encounter-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Classic items", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      const ruleset = { id: rulesetId, version: 1, packageId: null, options: {} };
      expect(
        (
          await request.patch(`/api/chats/${chatId}/metadata`, {
            data: {
              gameId: `classic-items-${chatId}`,
              gameSessionStatus: "active",
              gameIntroPresented: true,
              gameImageAutoGenerationEnabled: false,
              gameStoryboardAutoIllustrationsEnabled: false,
              enableAgents: false,
              gameRuleset: ruleset,
              gameInventory: [
                { id: "st-rope", name: "Rope", quantity: 1 },
                { id: "st-poultice", name: "Poultice", quantity: 3, item: "outfitter/poultice" },
                { id: "st-coat", name: "Leather coat", quantity: 1, item: "outfitter/leather-coat" },
              ],
            },
          })
        ).ok(),
      ).toBeTruthy();

      // The encounter's start, as the screen asks for it when the Game Master opens a fight.
      const init = await request.post("/api/encounter/init", { data: { chatId, settings: {} } });
      expect(init.ok(), await init.text()).toBeTruthy();
      const itemEffects = (await init.json()).combatState.itemEffects as Array<{ name: string; description: string }>;
      expect(itemEffects.map((effect) => [effect.name, effect.description])).toEqual([
        ["Poultice", "heals 1d4 + 1, range 0"],
        ["Rope", "Tangles a foe's legs"],
      ]);

      // The fight it opens, with the hero hurt.
      const unit = { maxHp: 100, attack: 5, defense: 5, speed: 5, level: 1, skills: [] };
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "A guard blocks the bridge. [state: combat]" },
      });
      expect(message.ok()).toBeTruthy();
      expect(
        (
          await request.patch(`/api/chats/${chatId}/metadata`, {
            data: {
              gameActiveState: "combat",
              gameCombatStyle: "classic",
              gameCombatState: {
                party: [{ ...unit, id: "hero", name: "Hero", side: "player", hp: 20 }],
                enemies: [{ ...unit, id: "guard", name: "Guard", side: "enemy", hp: 100, attack: 0 }],
                // A fight saved before the ruleset's items were worked out may still carry a guess for one.
                itemEffects: [
                  ...itemEffects,
                  { name: "Leather coat", target: "ally", type: "heal", description: "Guessed before" },
                ],
                mechanics: [],
                dialogueCues: [],
                startMessageId: (await message.json()).id,
                combatStyle: "classic",
              },
            },
          })
        ).ok(),
      ).toBeTruthy();
      await openGame(page, chatId);
      const items = page.getByRole("button", { name: "Items", exact: true });
      await expect(items).toBeVisible({ timeout: 40_000 });
      await items.click();
      const poultice = page.getByRole("button", { name: /^Poultice/ });
      await expect(poultice).toContainText("heals 1d4 + 1, range 0");
      await expect(page.getByRole("button", { name: /^Rope/ })).toContainText("Tangles a foe's legs");
      await expect(page.getByRole("button", { name: /^Leather coat/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("classic-ruleset-items.png") });

      // Pressed on the hero: 0.11 of 100 back, and one poultice fewer.
      const round = page.waitForResponse((r) => r.url().endsWith("/api/game/combat/round"));
      await poultice.click();
      const heroTarget = page.getByRole("button", { name: /Hero/ }).last();
      if (await heroTarget.isVisible().catch(() => false)) await heroTarget.click();
      const answer = await round;
      expect(answer.ok(), await answer.text()).toBeTruthy();
      const used = (
        (await answer.json()) as { result: { actions: Array<Record<string, unknown>> } }
      ).result.actions.find((action) => action.skillName === "Poultice");
      expect(used?.isHeal).toBe(true);
      expect(used?.finalDamage).toBe(11);
      await expect
        .poll(() => held(request, chatId))
        .toEqual([
          ["Rope", 1],
          ["Poultice", 2],
          ["Leather coat", 1],
        ]);
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

/** Gravewatch without the fights it resolves itself, whose page asks more than two dice can show, so
 *  its check always fails. */
function gravewatchWithoutFights(id: string): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = id;
  delete doc.combat;
  doc.catalogs = doc.catalogs.filter((catalog: { holds?: string }) => catalog.holds !== "creatures");
  const kit = doc.catalogs.find((catalog: { id: string }) => catalog.id === "kit");
  const page = kit.entries.find((entry: { id: string }) => entry.id === "litany-page").item;
  page.use.gate.difficulty = 100;
  // Pinned where it is worn to be read, so a fight spends the worn one and never the spare in the bag.
  page.slots = { worn: 1 };
  return JSON.stringify(doc);
}

test("a charged bell spends its charges and a failed page is spent for nothing in a Classic battle", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const model = await encounterModel({ party: [{ name: "Ada" }], enemies: [{ name: "Rat" }], itemEffects: [] });
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: { definition: gravewatchWithoutFights("grave-classic-charges-e2e") },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local encounter fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "encounter-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Classic charges", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      expect(
        (
          await request.patch(`/api/chats/${chatId}/metadata`, {
            data: {
              gameId: `classic-charges-${chatId}`,
              gameSessionStatus: "active",
              gameIntroPresented: true,
              gameImageAutoGenerationEnabled: false,
              gameStoryboardAutoIllustrationsEnabled: false,
              enableAgents: false,
              gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
              // Ada's Nerve of 1 is too low to skip the page's check.
              gameCharacterCards: [
                { name: "Ada", rulesetSheet: { v: 1, build: { abilities: { sinew: 2, nerve: 1, warmth: 2 } } } },
              ],
              gameInventory: [
                { id: "st-spare", name: "Page of the vigil litany", quantity: 1, item: "kit/litany-page" },
                {
                  id: "st-page",
                  name: "Page of the vigil litany",
                  quantity: 1,
                  item: "kit/litany-page",
                  equipped: true,
                },
                {
                  id: "st-bell",
                  name: "Dawn bell",
                  quantity: 1,
                  item: "kit/dawn-bell",
                  equipped: true,
                  bound: true,
                  charges: 2,
                },
              ],
            },
          })
        ).ok(),
      ).toBeTruthy();
      const init = await request.post("/api/encounter/init", { data: { chatId, settings: {} } });
      expect(init.ok(), await init.text()).toBeTruthy();
      const itemEffects = (await init.json()).combatState.itemEffects;
      const unit = { maxHp: 100, attack: 5, defense: 5, speed: 5, level: 1, skills: [] };
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "A rat bares its teeth. [state: combat]" },
      });
      expect(message.ok()).toBeTruthy();
      expect(
        (
          await request.patch(`/api/chats/${chatId}/metadata`, {
            data: {
              gameActiveState: "combat",
              gameCombatStyle: "classic",
              gameCombatState: {
                party: [{ ...unit, id: "ada", name: "Ada", side: "player", hp: 50 }],
                enemies: [{ ...unit, id: "rat", name: "Rat", side: "enemy", hp: 100, attack: 0 }],
                itemEffects,
                mechanics: [],
                dialogueCues: [],
                startMessageId: (await message.json()).id,
                combatStyle: "classic",
              },
            },
          })
        ).ok(),
      ).toBeTruthy();
      await openGame(page, chatId);
      const items = page.getByRole("button", { name: "Items", exact: true });
      await expect(items).toBeVisible({ timeout: 40_000 });
      await items.click();
      const bell = page.getByRole("button", { name: /^Dawn bell/ });
      await expect(bell).toContainText("spends 1 of 3 charges");
      await expect(bell).toContainText("x2");
      await page.screenshot({ path: testInfo.outputPath("classic-charges.png") });

      // Rung at the rat: one charge spent, one use left.
      const rung = page.waitForResponse((r) => r.url().endsWith("/api/game/combat/round"));
      await bell.click();
      await page.getByRole("button", { name: /^Rat HP/ }).click();
      expect((await rung).ok()).toBeTruthy();
      await expect
        .poll(() => held(request, chatId))
        .toEqual([
          ["Page of the vigil litany", 1],
          ["Page of the vigil litany", 1],
          ["Dawn bell", 1],
        ]);
      const charges = async () => {
        const row = await (await request.get(`/api/chats/${chatId}`)).json();
        const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
        return (metadata.gameInventory as Array<{ id: string; charges?: number }>).find(
          (stack) => stack.id === "st-bell",
        )?.charges;
      };
      await expect.poll(charges).toBe(1);

      // The worn page: Ada fails its check, it is spent, and the log says so; the spare stays in the bag.
      await expect(items).toBeVisible({ timeout: 20_000 });
      await items.click();
      const read = page.waitForResponse((r) => r.url().endsWith("/api/game/combat/round"));
      await page.getByRole("button", { name: /^Page of the vigil litany/ }).click();
      expect((await read).ok()).toBeTruthy();
      await expect(
        page
          .getByText(
            /^Ada rolls Ward to use Page of the vigil litany: \d+ against \d+, failed, and it is used up for nothing\.$/,
          )
          .first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => {
          const row = await (await request.get(`/api/chats/${chatId}`)).json();
          const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
          return (metadata.gameInventory as Array<{ id: string; quantity: number }>).map((stack) => [
            stack.id,
            stack.quantity,
          ]);
        })
        .toEqual([
          ["st-spare", 1],
          ["st-bell", 1],
        ]);
      await page.screenshot({ path: testInfo.outputPath("classic-failed-gate.png") });
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
