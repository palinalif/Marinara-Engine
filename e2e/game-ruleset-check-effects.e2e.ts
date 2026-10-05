import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { seedUIState } from "./ui-state-fixture.js";
import { inventoryButton } from "./game-inventory-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * What worn and carried items do to a check (#6832), on screen: an Ember Roads game whose player wears
 * the leather coat. The coat's details say it costs Sneak 1 while worn, and a Game Master turn that
 * asks for a Sneak check rolls it with the coat, and the dice card says so. The Game Master is a local
 * fixture; no provider is called.
 */
test("a worn item's effect is shown on the item and on the check it changes", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const provider = createServer(async (incoming, response) => {
    if (incoming.method !== "POST") {
      incoming.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const write = (delta: unknown, finishReason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    const followup = JSON.stringify(body.messages?.at(-1)?.content ?? "").includes("The engine has now rolled");
    write({
      content: followup
        ? "Ada slips along the wall, the coat creaking at every step."
        : `Ada creeps along the wall. [skill_check: skill="Sneak" dc="8"]`,
    });
    write({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const policyBefore = await request.get("/api/agents/import-policy");
  expect(policyBefore.ok(), await policyBefore.text()).toBeTruthy();
  const importsWereEnabled = (await policyBefore.json()).enabled === true;
  let connectionId = "";
  let chatId = "";
  let rulesetId = "";
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("The model fixture did not bind");
    const policy = await request.patch("/api/agents/import-policy", { data: { enabled: true } });
    expect(policy.ok(), await policy.text()).toBeTruthy();
    const doc = JSON.parse(
      readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"),
    );
    doc.id = "ember-check-effects-e2e";
    const imported = await request.post("/api/game-rulesets/import", { data: { definition: JSON.stringify(doc) } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    rulesetId = (await imported.json()).rulesetId as string;
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local check fixture",
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "synthetic-test-key",
        model: "check-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok(), await connection.text()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const chat = await request.post("/api/chats", {
      data: { name: "Worn items on checks", mode: "game", characterIds: [], connectionId },
    });
    expect(chat.ok()).toBeTruthy();
    chatId = (await chat.json()).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: chatId,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
        gameCharacterCards: [
          {
            name: "Ada",
            rulesetSheet: { v: 1, build: { abilities: { brawn: 0, wits: 0, heart: 0 }, fields: {}, lists: {} } },
          },
        ],
        gameInventory: [
          { id: "st-coat", name: "Leather coat", quantity: 1, item: "outfitter/leather-coat", equipped: true },
        ],
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: "Guards pace the gate of the caravan yard." },
        })
      ).ok(),
    ).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
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
    const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(narration).toContainText("Guards pace the gate", { timeout: 30_000 });

    // The coat says what it does while worn.
    await inventoryButton(page).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "Leather coat, worn", exact: true }).click();
    await expect(page.getByText("While worn: -1 on checks (Sneak)", { exact: true })).toBeVisible();
    // The inventory's close button is its header's only button, and shows only an icon.
    await page.getByRole("heading", { name: "Inventory", exact: true }).locator("xpath=../../button").click();

    // And the check it changes says so.
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I sneak past the guards.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    const card = page.locator(".skill-check-roll--game");
    await expect(card).toContainText("Sneak", { timeout: 30_000 });
    await expect(card).toContainText("Conditions and items: -1 to this roll");
    await expect(card).toContainText("Changed by Leather coat");
    await card.screenshot({ path: testInfo.outputPath("ruleset-check-effects-card.png") });
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/chats/${chatId}/messages`)).json()).at(-1)?.content ?? "") as string,
      )
      .toMatch(/\[skill_check: skill="Sneak" dc="8" [^\]]*effects="-1" from="Leather coat"\]/);
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`);
    if (rulesetId) await request.delete(`/api/game-rulesets?rulesetId=${encodeURIComponent(rulesetId)}&force=true`);
    const restored = await request.patch("/api/agents/import-policy", { data: { enabled: importsWereEnabled } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
