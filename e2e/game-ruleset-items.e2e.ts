import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { inventoryButton } from "./game-inventory-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * A ruleset's own items in the inventory (#6795): picked from its catalog, found by a typed name,
 * shown with what they are, and stacked no higher than the ruleset allows. A ruleset that takes only
 * its own items offers only the picker. An item the Game Master invented (#6814) reads like one of the
 * ruleset's own and says what was changed to fit it. A ruleset that turns Game Mode's own items off
 * (#6822) offers none in a fight. Each run imports Ember Roads under its own id, so no other
 * spec's copy is touched, and removes it afterwards.
 */
function emberRoads(id: string, edit: (doc: Record<string, any>) => void = () => {}): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"));
  doc.id = id;
  // This test is about which item a name is and how many one stack holds; carrying is tested in
  // game-ruleset-wearing.e2e.ts.
  delete doc.items.carry;
  for (const family of doc.items.currencies ?? []) delete family.perWeight;
  edit(doc);
  return JSON.stringify(doc);
}

async function seedGame(request: APIRequestContext, rulesetId: string) {
  const created = await request.post("/api/chats", {
    data: { name: "Ruleset items", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as { id: string };
  const meta = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      gameId: `ruleset-items-${rulesetId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
      gameInventory: [{ id: "st-rope", name: "Rope", quantity: 1 }],
    },
  });
  expect(meta.ok(), await meta.text()).toBeTruthy();
  const saved = await request.post(`/api/chats/${chat.id}/messages`, {
    data: { role: "assistant", content: "The outfitter's stall smells of oil and leather." },
  });
  expect(saved.ok()).toBeTruthy();
  return chat.id;
}

async function openInventory(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    gameInstantTextReveal: true,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
  await inventoryButton(page).click({ timeout: 30000 });
}

test("a ruleset's items are picked, found by name, shown with what they are and stacked by its size, and invented ones say so", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  const chats: string[] = [];
  const rulesets: string[] = [];
  const importRuleset = async (definition: string) => {
    const imported = await request.post("/api/game-rulesets/import", { data: { definition } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    const rulesetId = (await imported.json()).rulesetId as string;
    rulesets.push(rulesetId);
    return rulesetId;
  };
  try {
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    const emberId = await importRuleset(emberRoads("ember-inventory-e2e"));
    const chatId = await seedGame(request, emberId);
    chats.push(chatId);
    const savedInventory = async () => {
      const row = await (await request.get(`/api/chats/${chatId}`)).json();
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      return (metadata.gameInventory as Array<{ name: string; item?: string; quantity: number }>).map(
        (stack) => `${stack.name}${stack.item ? ` <${stack.item}>` : ""} ${stack.quantity}`,
      );
    };
    await openInventory(page, chatId);
    const slot = (label: string) => page.getByRole("button", { name: label, exact: true });

    // The picker offers the ruleset's items with what each one is.
    await page.getByRole("button", { name: "From the ruleset", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add items from the ruleset" });
    await expect(picker).toBeVisible();
    await picker.getByRole("searchbox").fill("hand axe");
    await expect(picker.getByRole("checkbox")).toHaveCount(1);
    await expect(
      picker.getByText("Bulk 1 · Damage 1d6 · Rolls with brawn · Reach close", { exact: true }),
    ).toBeVisible();
    await expect(picker.getByText("Price in marks: 4", { exact: true })).toBeVisible();
    await picker.getByRole("checkbox", { name: "Hand axe", exact: true }).check();
    await picker.getByRole("searchbox").fill("");
    await picker.getByRole("checkbox", { name: "Arrows", exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath("ruleset-item-picker.png") });
    await picker.getByRole("button", { name: "Add 2 items", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(slot("Hand axe")).toBeVisible();
    await expect(slot("Arrows")).toBeVisible();
    await expect
      .poll(savedInventory)
      .toEqual(["Rope 1", "Hand axe <outfitter/hand-axe> 1", "Arrows <outfitter/arrows> 1"]);

    // The last one picked is selected and says what it is, and how many one stack holds.
    await expect(page.getByText("Ammunition", { exact: true })).toBeVisible();
    await expect(page.getByText("Bulk 1", { exact: true })).toBeVisible();
    await expect(page.getByText("One stack holds up to 20.", { exact: true })).toBeVisible();
    // Twenty-five arrows are a stack of twenty and a new one of five.
    const amount = page.getByLabel("Arrows amount", { exact: true });
    await amount.fill("25");
    await amount.press("Enter");
    await expect(slot("Arrows x20")).toBeVisible();
    await expect(slot("Arrows x5")).toBeVisible();
    await expect(page.getByText("Added 24 Arrows.", { exact: true })).toBeVisible();

    // A typed name that is one of the ruleset's items is that item.
    await page.getByLabel("Name of the item to add", { exact: true }).fill("HAND AXE");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(slot("Hand axe x2")).toBeVisible();
    await expect
      .poll(savedInventory)
      .toEqual([
        "Rope 1",
        "Hand axe <outfitter/hand-axe> 2",
        "Arrows <outfitter/arrows> 20",
        "Arrows <outfitter/arrows> 5",
      ]);
    await page.screenshot({ path: testInfo.outputPath("ruleset-items.png") });

    // A ruleset that takes only its own items has no name to type, only the picker.
    const strictId = await seedGame(
      request,
      await importRuleset(
        emberRoads("ember-strict-e2e", (doc) => {
          doc.items.freeform = "refuse";
        }),
      ),
    );
    chats.push(strictId);
    // On a page of its own: the first page's start-up script still names the first chat, and the order
    // two such scripts run in is not defined.
    const strictPage = await page.context().newPage();
    await openInventory(strictPage, strictId);
    await expect(strictPage.getByRole("button", { name: "From the ruleset", exact: true })).toBeVisible();
    await expect(strictPage.getByLabel("Name of the item to add", { exact: true })).toHaveCount(0);
    await strictPage.close();

    // An item the Game Master invented (#6814) reads like one of the ruleset's own, says it was
    // invented, and shows what the Engine changed to fit the ruleset.
    const inventedId = await seedGame(request, emberId);
    chats.push(inventedId);
    const invented = await request.patch(`/api/chats/${inventedId}/metadata`, {
      data: {
        gameInventory: [{ id: "st-edge", name: "Mourning Edge", item: "invented:mourning-edge", quantity: 1 }],
        gameInventedItems: [
          {
            id: "mourning-edge",
            name: "Mourning Edge",
            item: { category: "weapon", rarity: "storied", stats: { guard: 3, damage: "1d10" }, slots: { hands: 1 } },
            summary: "Her husband's blade, still sharp.",
            notes: ["Guard is 3 instead of 4, the most at Storied."],
          },
        ],
      },
    });
    expect(invented.ok(), await invented.text()).toBeTruthy();
    const inventedPage = await page.context().newPage();
    await openInventory(inventedPage, inventedId);
    await inventedPage.getByRole("button", { name: "Mourning Edge", exact: true }).click();
    await expect(inventedPage.getByText("Storied", { exact: true })).toBeVisible();
    await expect(inventedPage.getByText("Guard 3 · Damage 1d10", { exact: true })).toBeVisible();
    await expect(inventedPage.getByText("Her husband's blade, still sharp.", { exact: true })).toBeVisible();
    await expect(inventedPage.getByText("Invented by the Game Master.", { exact: true })).toBeVisible();
    await inventedPage.getByText("What the Engine changed to fit the ruleset", { exact: true }).click();
    await expect(
      inventedPage.getByText("Guard is 3 instead of 4, the most at Storied.", { exact: true }),
    ).toBeVisible();
    await inventedPage.screenshot({ path: testInfo.outputPath("ruleset-invented-item.png") });
    await inventedPage.close();
  } finally {
    for (const id of chats) await request.delete(`/api/chats/${id}`);
    for (const id of rulesets) {
      await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(id)}&force=true`);
    }
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});

test("a ruleset without Game Mode's own items offers none in a fight", async ({ page, request }, testInfo) => {
  test.setTimeout(120000);
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  const chats: string[] = [];
  const rulesets: string[] = [];
  try {
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    const unit = { hp: 30, maxHp: 30, attack: 5, defense: 5, speed: 5, level: 1, skills: [] };
    // A classic fight restored mid-way, with a potion in the bag and an effect guessed for it.
    const fightIn = async (nativeItems: boolean) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: {
          definition: emberRoads(nativeItems ? "ember-fight-items-e2e" : "ember-fight-no-items-e2e", (doc) => {
            doc.items.native = nativeItems;
          }),
        },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      rulesets.push(rulesetId);
      const chatId = await seedGame(request, rulesetId);
      chats.push(chatId);
      const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameInventory: [{ id: "st-potion", name: "Potion", quantity: 3 }],
          gameActiveState: "combat",
          gameImageAutoGenerationEnabled: false,
          gameStoryboardAutoIllustrationsEnabled: false,
          gameCombatStyle: "classic",
          gameCombatState: {
            party: [{ ...unit, id: "hero", name: "Hero", side: "player" }],
            enemies: [{ ...unit, id: "guard", name: "Guard", side: "enemy" }],
            itemEffects: [{ name: "Potion", target: "self", type: "heal", description: "Restore HP" }],
            mechanics: [],
            dialogueCues: [],
            combatStyle: "classic",
          },
        },
      });
      expect(meta.ok(), await meta.text()).toBeTruthy();
      const fightPage = await page.context().newPage();
      await fightPage.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(fightPage, {
        hasCompletedOnboarding: true,
        rightPanelOpen: false,
        sidebarOpen: false,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        gameInstantTextReveal: true,
      });
      await fightPage.addInitScript(
        ({ id, appVersion }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", appVersion);
        },
        { id: chatId, appVersion: version },
      );
      await fightPage.goto("/");
      const items = fightPage.getByRole("button", { name: "Items", exact: true });
      await expect(items).toBeVisible({ timeout: 40000 });
      await items.click();
      return fightPage;
    };

    // Game Mode's own items: the potion is offered.
    const withItems = await fightIn(true);
    await expect(withItems.getByRole("button", { name: /Potion/ })).toBeVisible();
    await withItems.close();
    // Turned off: nothing is offered, whatever effect was guessed for it.
    const withoutItems = await fightIn(false);
    await expect(withoutItems.getByRole("button", { name: /Potion/ })).toHaveCount(0);
    await withoutItems.screenshot({ path: testInfo.outputPath("ruleset-fight-no-items.png") });
    await withoutItems.close();
  } finally {
    for (const id of chats) await request.delete(`/api/chats/${id}`);
    for (const id of rulesets) {
      await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(id)}&force=true`);
    }
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
  }
});
