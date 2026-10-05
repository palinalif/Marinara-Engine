import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// #6959: a reply sent while a narration mode switch is still saving must use the mode Chat Settings shows.
test("a reply waits for the narration mode it was sent under", async ({ page, request }, info) => {
  test.skip(!info.project.name.includes("desktop"), "The save order is the same on every viewport.");
  const prompts: string[] = [];
  const provider = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    prompts.push(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).messages));
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "A reply." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const resources: string[] = [];
  const create = async (path: string, data: unknown) => {
    const response = await request.post(path, { data });
    expect(response.ok(), await response.text()).toBeTruthy();
    const value = await response.json();
    resources.unshift(`${path}/${value.id}`);
    return value as { id: string };
  };
  try {
    const connection = await create("/api/connections", {
      name: "Narration mode fixture",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "synthetic-test-key",
      model: "narration-fixture",
      maxContext: 32768,
    });
    const characters = [];
    for (const name of ["Joe Smith", "Jane Doe"]) characters.push(await create("/api/characters", { data: { name } }));
    const chat = await create("/api/chats", {
      name: "Narration mode proof",
      mode: "roleplay",
      characterIds: characters.map((character) => character.id),
      connectionId: connection.id,
    });
    const patched = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: { enableAgents: false, enableTools: false },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();
    const seeded = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "user", content: "Begin the scene." },
    });
    expect(seeded.ok(), await seeded.text()).toBeTruthy();

    // Hold the mode save so the reply is requested while it is still in flight.
    let releaseModeSave = () => {};
    const modeSaveHeld = new Promise<void>((resolve) => (releaseModeSave = resolve));
    let modeSaves = 0;
    await page.route(`**/api/chats/${chat.id}/metadata`, async (route) => {
      if (route.request().method() === "PATCH" && route.request().postData()?.includes("groupChatMode")) {
        modeSaves++;
        await modeSaveHeld;
      }
      await route.continue();
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["roleplay"],
      debugMode: false,
      streamingSpeed: 100,
      enterToSendRP: true,
    });
    await page.addInitScript(
      ({ id, seenVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", seenVersion);
      },
      { id: chat.id, seenVersion: version },
    );
    await page.goto("/");

    await page.getByRole("button", { name: "Chat Settings", exact: true }).filter({ visible: true }).click();
    const drawer = page.locator(".mari-chat-settings-drawer");
    const section = drawer.locator('[data-chat-settings-section="roleplay-group-chat"]');
    const header = section.locator(':scope > [role="button"]');
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await section.getByRole("button", { name: "Individual", exact: true }).click();
    await expect.poll(() => modeSaves).toBe(1);

    const replyRequested = page
      .waitForRequest((sent) => sent.method() === "POST" && new URL(sent.url()).pathname === "/api/generate", {
        timeout: 1_500,
      })
      .then(
        () => true,
        () => false,
      );
    // Chat Settings stays open over the send button until its saves land, so send from the keyboard.
    const composer = page.locator('textarea[placeholder*="/ for commands"]');
    await composer.fill("Hello, both of you.");
    await composer.press("Enter");
    expect(await replyRequested, "the reply waits for the narration mode to be stored").toBe(false);

    releaseModeSave();
    await expect.poll(() => prompts.length).toBe(2);
    expect(prompts[0]).toContain("Respond ONLY as Joe Smith.");
    expect(prompts[1]).toContain("Respond ONLY as Jane Doe.");
  } finally {
    for (const path of resources) await request.delete(path).catch(() => undefined);
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
