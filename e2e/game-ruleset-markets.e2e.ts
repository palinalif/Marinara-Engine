import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { inventoryButton } from "./game-inventory-fixture.js";
import { openGame, savedInventory, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * Markets (#6917), on a real turn. The Game Master says the party is in a market town and buys there:
 * the Engine prices a dear coat and a bed at the watch-house (a service), pays for both out of the
 * purse with change, puts the coat in the bag, refuses a pistol only a city sells, and shows a
 * notification for each purchase. The next turn's prompt carries the MARKET block for that town.
 */

function gravewatch(id: string): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = id;
  return JSON.stringify(doc);
}

/** A local model that answers by what the player just said, and keeps every prompt it was sent. No
 *  paid provider is called. */
async function fakeModel(
  replies: Array<[said: string, reply: string]>,
): Promise<{ server: Server; baseUrl: string; prompts: string[] }> {
  const prompts: string[] = [];
  const server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (incoming.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    prompts.push(body);
    // Only what the player said last: a later prompt carries the whole history before it.
    let last = body;
    try {
      const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const said = [...messages].reverse().find((message) => message.role === "user")?.content;
      last = typeof said === "string" ? said : JSON.stringify(said ?? "");
    } catch {
      // Not a chat request: answer from the whole body.
    }
    const reply = replies.find(([said]) => last.includes(said))?.[1] ?? "The night is quiet.";
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const write = (delta: unknown, finishReason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    write({ content: reply });
    write({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The model fixture did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, prompts };
}

test("the Game Master buys at a market town: priced, paid with change, a service only paid, a city's pistol refused", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const model = await fakeModel([
    [
      "I buy a coat and a bed.",
      'We reach Barrowmere. [place: name="Barrowmere" size="market town"] The chandler drives a hard bargain. ' +
        '[inventory: action="buy" item="Lantern-keeper\'s coat" level="dear"] ' +
        '[inventory: action="buy" item="A bed at the watch-house"] ' +
        '[inventory: action="buy" item="Watch pistol"]',
    ],
    ["I look around the square.", "Stalls and lanterns crowd the square."],
  ]);
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: { definition: gravewatch("gravewatch-markets-e2e") },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local market fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "market-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Markets", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `markets-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
          gameInventory: [{ id: "st-crowns", name: "crowns", item: "coin:crown", quantity: 3 }],
        },
      });
      expect(meta.ok(), await meta.text()).toBeTruthy();
      expect(
        (
          await request.post(`/api/chats/${chatId}/messages`, {
            data: { role: "assistant", content: "The road bends toward the lights of a town." },
          })
        ).ok(),
      ).toBeTruthy();
      await openGame(page, chatId);
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
        "The road bends toward the lights of a town.",
        { timeout: 30_000 },
      );

      await page.getByPlaceholder("What do you do?", { exact: true }).fill("I buy a coat and a bed.");
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(page.getByText(/^You bought Lantern-keeper's coat for 12 shillings\.$/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/^You bought A bed at the watch-house for 6 pennies\.$/)).toBeVisible();
      await expect(page.getByText(/bought Watch pistol/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("market-bought.png") });
      // Two crowns and a third broken for the coat, 3 shillings back; a shilling broken for the bed,
      // 6 pennies back. The coat is in the bag; the bed and the pistol are not.
      await expect
        .poll(async () =>
          (await savedInventory(request, chatId))
            .map((stack) => `${stack.name} <${stack.item ?? ""}> ${stack.quantity}`)
            .sort(),
        )
        .toEqual([
          "Lantern-keeper's coat <kit/lantern-coat> 1",
          "pennies <coin:penny> 6",
          "shillings <coin:shilling> 2",
        ]);
      const saved = await (await request.get(`/api/chats/${chatId}/messages`)).json();
      const reply = (saved as Array<{ role: string; content: string }>)
        .filter((message) => message.role === "assistant")
        .at(-1)!;
      expect(reply.content).toContain('[place: name="Barrowmere" size="town" result="ok"]');
      expect(reply.content).toContain('item="Watch pistol" count="1" result="refused" reason="not-here"');

      // The next turn: the place said last turn is still where the party is, and the Game Master
      // is shown what it sells.
      const before = model.prompts.length;
      await page.getByPlaceholder("What do you do?", { exact: true }).fill("I look around the square.");
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
        "Stalls and lanterns crowd the square.",
        { timeout: 30_000 },
      );
      const prompt = model.prompts.slice(before).find((body) => body.includes("I look around the square."));
      expect(prompt).toBeTruthy();
      expect(prompt).toContain("MARKET: Barrowmere, a market town. Prices at fair, the default level");
      expect(prompt).toContain("- smith: Grave spade 3 shillings, Silver coffin nail 2 crowns");

      // The picker never offers a service: a bed at the watch-house is bought, not carried.
      await inventoryButton(page).click();
      await page.getByRole("button", { name: "From the ruleset", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Add items from the ruleset" });
      await expect(picker.getByRole("checkbox", { name: "Lantern-keeper's coat", exact: true })).toBeVisible();
      await expect(picker.getByRole("checkbox", { name: "A bed at the watch-house", exact: true })).toHaveCount(0);
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
