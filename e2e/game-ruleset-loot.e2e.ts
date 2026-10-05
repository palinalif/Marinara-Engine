import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { DirectedCombatView } from "@marinara-engine/shared";
import { openGame, savedInventory, seedFight, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * Loot (#6894, #6758), on screen. A won fight drops its loot into the bags before the recap goes out:
 * Game Mode's own treasure in a game without a ruleset, asked for once by the screen that played the
 * fight, and a ruleset creature's own table in a fight the combat director won, which dropped it on the
 * step that won and is never asked for again.
 */

/** The player's message to the Game Master, captured instead of answered. */
async function captureSent(page: Page): Promise<() => string | null> {
  let sent: string | null = null;
  await page.route("**/api/generate", async (route) => {
    sent = JSON.stringify(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' });
  });
  return () => sent;
}

/** Every item dropped, as the recap names it: "Name" or "Name ×3". */
const named = (loot: Array<{ name: string; quantity?: number }>) =>
  loot.map((drop) => (drop.quantity && drop.quantity > 1 ? `${drop.name} ×${drop.quantity}` : drop.name));

test("a won fight without a ruleset drops Game Mode's loot into the player's bag", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/game/create", {
    data: {
      name: "Native loot",
      setupConfig: {
        genre: "Fantasy",
        setting: "Ruins",
        tone: "Adventure",
        difficulty: "normal",
        playerGoals: "Hold",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: false,
        gmBossControl: false,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  try {
    const unit = (id: string, side: "player" | "enemy", hp: number) => ({
      id,
      name: id,
      side,
      hp,
      maxHp: 30,
      attack: 5,
      defense: 5,
      speed: 5,
      level: 1,
      skills: [],
    });
    const message = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "The last guard staggers. [state: combat]" },
    });
    expect(message.ok()).toBeTruthy();
    // The guard is already down, so the fight opens on its Victory.
    const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameActiveState: "combat",
        gameImageAutoGenerationEnabled: false,
        gameStoryboardAutoIllustrationsEnabled: false,
        gameCombatStyle: "classic",
        gameCombatState: {
          party: [unit("Hero", "player", 30)],
          enemies: [unit("Guard", "enemy", 0)],
          itemEffects: [],
          mechanics: [],
          dialogueCues: [],
          startMessageId: (await message.json()).id,
          combatStyle: "classic",
        },
      },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();
    const sent = await captureSent(page);
    await openGame(page, chatId);
    const looted = page.waitForResponse((r) => r.url().endsWith("/api/game/inventory/loot"));
    await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 40_000 });
    const answer = await looted;
    expect(answer.ok(), await answer.text()).toBeTruthy();
    const loot = ((await answer.json()) as { loot: Array<{ name: string; quantity: number }> }).loot;
    expect(loot.length).toBeGreaterThan(0);
    // The Game Master is told it is already in the bags, and the player sees it.
    await expect.poll(sent).toContain("Loot (already in the party's bags): ");
    for (const drop of named(loot)) expect(sent()).toContain(drop);
    await expect(page.getByText(`Loot: ${named(loot).join(", ")}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("loot-native.png"), fullPage: true });
    const held = await savedInventory(request, chatId);
    expect(held.reduce((sum, stack) => sum + stack.quantity, 0)).toBe(
      loot.reduce((sum, drop) => sum + drop.quantity, 0),
    );
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("the recap reaches the chat the fight ended in, even after the player leaves it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/game/create", {
    data: {
      name: "Loot on the way out",
      setupConfig: {
        genre: "Fantasy",
        setting: "Ruins",
        tone: "Adventure",
        difficulty: "normal",
        playerGoals: "Hold",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: false,
        gmBossControl: false,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  try {
    const unit = (id: string, side: "player" | "enemy", hp: number) => ({
      id,
      name: id,
      side,
      hp,
      maxHp: 30,
      attack: 5,
      defense: 5,
      speed: 5,
      level: 1,
      skills: [],
    });
    const message = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "The last guard staggers. [state: combat]" },
    });
    expect(message.ok()).toBeTruthy();
    const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameActiveState: "combat",
        gameImageAutoGenerationEnabled: false,
        gameStoryboardAutoIllustrationsEnabled: false,
        gameCombatStyle: "classic",
        gameCombatState: {
          party: [unit("Hero", "player", 30)],
          enemies: [unit("Guard", "enemy", 0)],
          itemEffects: [],
          mechanics: [],
          dialogueCues: [],
          startMessageId: (await message.json()).id,
          combatStyle: "classic",
        },
      },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();
    const sent = await captureSent(page);
    // The drop is held until the player has gone back to the home screen.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    await page.route("**/api/game/inventory/loot", async (route) => {
      const response = await route.fetch();
      asked = true;
      await released;
      await route.fulfill({ response });
    });
    await openGame(page, chatId);
    await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 40_000 });
    await expect.poll(() => asked).toBe(true);
    await page.getByTitle("Home", { exact: true }).click();
    release();
    // Still told, and told in that chat, so reopening it never starts the fight again.
    await expect.poll(sent).toContain("Loot (already in the party's bags): ");
    expect(sent()).toContain(`"chatId":"${chatId}"`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

/** The fighters a directed ruleset fight starts with: the ruleset reads their real numbers. */
const fighter = (id: string, name: string, side: "player" | "enemy") => ({
  id,
  name,
  side,
  hp: 30,
  maxHp: 30,
  attack: 8,
  defense: 6,
  speed: 6,
  level: 3,
});
const rulesetParty = [fighter("juno", "Juno", "player"), fighter("bram", "Bram", "player")];
const rulesetFoes = [fighter("moth", "Cinder Moth", "enemy")];

/** A directed ruleset fight driven through the director until it is won, or null when the party lost. */
async function winRulesetFight(
  request: APIRequestContext,
  chatId: string,
  anchor: string,
): Promise<DirectedCombatView | null> {
  const start = await request.post("/api/game/combat/director/start", {
    data: {
      chatId,
      anchor,
      style: "ruleset",
      party: rulesetParty,
      enemies: rulesetFoes,
    },
  });
  expect(start.ok(), await start.text()).toBeTruthy();
  let session = (await start.json()).session as DirectedCombatView;
  let requests = 0;
  const command = async (body: Record<string, unknown>) => {
    const answer = await request.post("/api/game/combat/director/command", {
      data: {
        chatId,
        anchor,
        id: session.id,
        instanceId: session.instanceId,
        revision: session.revision,
        requestId: `loot-${++requests}`,
        command: body,
      },
    });
    expect(answer.ok(), await answer.text()).toBeTruthy();
    session = (await answer.json()).session as DirectedCombatView;
  };
  for (const id of ["juno", "bram"]) await command({ type: "control", unitId: id, controller: "ai" });
  for (let step = 0; step < 300 && !session.outcome; step++) await command({ type: "continue" });
  return session.outcome === "victory" ? session : null;
}

test("a won ruleset fight drops its creature's table, and the screen never asks again", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await withImports(request, async (cleanup) => {
    const doc = JSON.parse(
      readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"),
    );
    doc.id = "ember-loot-e2e";
    doc.items.lootTables = [
      {
        id: "road_spoils",
        label: "Road spoils",
        entries: [
          { item: "outfitter/arrows", weight: 3, count: "1d6" },
          { item: "outfitter/road-rations", weight: 3, count: "1d3" },
          { item: "outfitter/poultice", weight: 2 },
        ],
      },
    ];
    const bestiary = doc.catalogs.find((catalog: { id: string }) => catalog.id === "road_trouble");
    bestiary.entries.find((entry: { id: string }) => entry.id === "cinder-moth").creature.loot = "road_spoils";
    const strong = { v: 1, build: { abilities: { brawn: 14, wits: 12, heart: 12 }, fields: {}, lists: {} } };
    let won: { chatId: string; anchor: string; session: DirectedCombatView } | null = null;
    for (let attempt = 0; attempt < 5 && !won; attempt++) {
      const seeded = await seedFight(
        request,
        { ...doc, id: `ember-loot-e2e-${attempt}` },
        { name: "Road spoils", genre: "Fantasy", setting: "The road", tone: "Adventure" },
        {
          gameCharacterCards: [
            { name: "Juno", rulesetSheet: strong },
            { name: "Bram", rulesetSheet: strong },
          ],
          // A sheet's attacks are the weapons it holds.
          gameInventory: [
            { id: "st-axe-juno", name: "Hand axe", quantity: 1, item: "outfitter/hand-axe", equipped: true },
            {
              id: "st-axe-bram",
              name: "Hand axe",
              quantity: 1,
              item: "outfitter/hand-axe",
              holder: "Bram",
              equipped: true,
            },
          ],
        },
        {},
        "A cinder moth drifts out of the ash.",
      );
      cleanup.push(seeded);
      const session = await winRulesetFight(request, seeded.chatId, seeded.anchor);
      if (session) won = { chatId: seeded.chatId, anchor: seeded.anchor, session };
    }
    expect(won, "one of the fights was won").toBeTruthy();
    const { chatId, anchor, session } = won!;
    const loot = session.summary?.loot ?? [];
    expect(loot.length).toBeGreaterThan(0);
    // The director already wrote it to the bags, as the ruleset's own items.
    const held = await savedInventory(request, chatId);
    for (const drop of loot) {
      expect(
        held.find((stack) => (stack as { name?: string }).name === drop.name),
        drop.name,
      ).toBeTruthy();
    }
    const combat = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameActiveState: "combat",
        gameCombatState: {
          party: rulesetParty,
          enemies: rulesetFoes,
          itemEffects: [],
          mechanics: [],
          dialogueCues: [],
          startMessageId: anchor,
          combatStyle: "classic",
        },
      },
    });
    expect(combat.ok(), await combat.text()).toBeTruthy();
    let asked = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/game/inventory/loot")) asked += 1;
    });
    const sent = await captureSent(page);
    await openGame(page, chatId);
    await page.getByRole("button", { name: "Continue story", exact: true }).click({ timeout: 40_000 });
    await expect.poll(sent).toContain("Loot (already in the party's bags): ");
    for (const drop of named(loot)) expect(sent()).toContain(drop);
    await page.screenshot({ path: testInfo.outputPath("loot-ruleset.png"), fullPage: true });
    expect(asked, "a directed fight's loot is never asked for again").toBe(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
