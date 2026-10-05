import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jX8AAAAASUVORK5CYII=",
  "base64",
);

test("reference uploads, captions, removal and wardrobe keyword preserve entry text", async ({
  page,
  request,
}, info) => {
  const book = await (await request.post("/api/lorebooks", { data: { name: "Wardrobe image editor" } })).json();
  const entry = await (
    await request.post(`/api/lorebooks/${book.id}/entries`, {
      data: { name: "Blue coat", content: "Original coat description" },
    })
  ).json();
  let releaseUpload = () => {};
  let releaseSecondUpload = () => {};
  let releaseCaptionSave = () => {};
  let releaseEntryRefresh = () => {};
  const errors: string[] = [];
  const browserDiagnostics: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserDiagnostics.push(message.text());
  });
  page.on("requestfailed", (request) => browserDiagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => errors.push(error.message));
  const readEntry = async () => await (await request.get(`/api/lorebooks/${book.id}/entries/${entry.id}`)).json();
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: info.project.name.includes("mobile") ? "dark" : "light",
    });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    await page.goto("/");
    await page.evaluate(async (id) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().openLorebookDetail(id);
    }, book.id);
    const row = page.locator(`[data-lorebook-entry-row-id="${entry.id}"]`);
    await row.getByRole("button", { name: "Expand entry", exact: true }).click();
    const references = row.getByRole("region", { name: "Reference images" });
    await references.scrollIntoViewIfNeeded();
    const disclosure = references.getByRole("button", { name: /^Reference images/ });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeHidden();
    await page.screenshot({ path: info.outputPath("references-collapsed-empty.png") });
    await disclosure.focus();
    await disclosure.press("Space");
    await page.screenshot({ path: info.outputPath("references-empty.png") });
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecondUpload = resolve;
    });
    let uploadRequests = 0;
    await page.route(`**/api/lorebooks/${book.id}/entries/${entry.id}/images`, async (route) => {
      await (++uploadRequests === 1 ? gate : secondGate);
      await route.continue();
    });
    await references
      .locator('input[type="file"]')
      .setInputFiles({ name: "coat.png", mimeType: "image/png", buffer: png });
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("references-loading.png") });
    const duplicate = row.getByRole("button", { name: "Duplicate entry", exact: true });
    await duplicate.scrollIntoViewIfNeeded();
    await row.hover();
    await page.screenshot({ path: info.outputPath("duplicate-during-upload.png") });
    await expect(duplicate).toBeDisabled();
    // Collapsing the row unmounts the image editor while its upload keeps running.
    await row.getByRole("button", { name: "Collapse entry", exact: true }).click();
    await row.getByRole("button", { name: "Expand entry", exact: true }).click();
    await disclosure.click();
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    await references
      .locator('input[type="file"]')
      .setInputFiles({ name: "boots.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => uploadRequests).toBe(2);
    const refreshed = page.waitForResponse((response) => response.url().endsWith(`/api/lorebooks/${book.id}/entries`));
    releaseUpload();
    await (await refreshed).finished();
    await expect.poll(async () => (await readEntry()).images.length).toBe(1);
    await page.screenshot({ path: info.outputPath("duplicate-during-remounted-upload.png") });
    await expect(duplicate).toBeDisabled();
    // Filtering the entry out remounts the whole row, which must read the same pending mutation.
    const search = page.getByPlaceholder("Search entries…", { exact: true });
    await search.fill("no matching entry");
    await expect(row).toHaveCount(0);
    await search.fill("");
    await expect(duplicate).toBeDisabled();
    await disclosure.click();
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    const entryRefresh = new Promise<void>((resolve) => {
      releaseEntryRefresh = resolve;
    });
    let refreshingEntry = false;
    await page.route(
      `**/api/lorebooks/${book.id}/entries`,
      async (route) => {
        refreshingEntry = true;
        await entryRefresh;
        await route.continue();
      },
      { times: 1 },
    );
    releaseSecondUpload();
    await expect.poll(() => refreshingEntry).toBe(true);
    await page.screenshot({ path: info.outputPath("duplicate-awaiting-entry-refresh.png") });
    await expect(duplicate).toBeDisabled();
    releaseEntryRefresh();
    await expect(references.getByRole("img")).toHaveCount(2);
    await expect.poll(async () => (await readEntry()).images.length).toBe(2);
    await expect(duplicate).toBeEnabled();
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Blue velvet coat with silver buttons");
    await expect(disclosure).toHaveText(/Reference images.*\(2\)/);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Blue velvet coat with silver buttons");
    await page.screenshot({ path: info.outputPath("references-collapsed-populated.png") });
    await disclosure.click();
    await expect(references.getByRole("textbox", { name: "Caption" }).first()).toHaveValue(
      "Blue velvet coat with silver buttons",
    );
    // A caption blur must not swallow the immediately following action.
    await references.getByRole("button", { name: "Add wardrobe key" }).click();
    await expect.poll(async () => (await readEntry()).keys).toContain("wardrobe");
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Blue velvet coat with silver buttons");
    expect((await readEntry()).content).toBe("Original coat description");
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Pending caption copied immediately");
    await row.getByRole("button", { name: "Duplicate entry", exact: true }).click();
    await expect
      .poll(async () => {
        const entries = await (await request.get(`/api/lorebooks/${book.id}/entries`)).json();
        return entries.find((candidate: { id: string }) => candidate.id !== entry.id)?.images[0]?.caption;
      })
      .toBe("Pending caption copied immediately");
    const entries = await (await request.get(`/api/lorebooks/${book.id}/entries`)).json();
    const copied = entries.find((candidate: { id: string }) => candidate.id !== entry.id);
    expect(copied.images.map((image: { path: string }) => image.path)).toEqual(
      (await readEntry()).images.map((image: { path: string }) => image.path),
    );
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async (theme) => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().setTheme(theme);
      }, theme);
      for (const width of info.project.name.includes("desktop") ? [1440, 768, 390] : [390]) {
        await page.setViewportSize({ width, height: 900 });
        await references.scrollIntoViewIfNeeded();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await page.screenshot({ path: info.outputPath(`references-${theme}-${width}.png`) });
        await disclosure.click();
        await expect(references.getByRole("img")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`references-collapsed-${theme}-${width}.png`) });
        await disclosure.click();
      }
    }
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Saved while removing boots");
    const removal = new Promise<void>((resolve) => {
      releaseCaptionSave = resolve;
    });
    await page.route(
      `**/api/lorebooks/${book.id}/entries/${entry.id}`,
      async (route) => {
        await removal;
        await route.continue();
      },
      { times: 1 },
    );
    await references.getByRole("button", { name: "Remove image" }).last().click();
    await page.screenshot({ path: info.outputPath("duplicate-during-image-removal.png") });
    await expect(duplicate).toBeDisabled();
    await search.fill("no matching entry");
    await expect(row).toHaveCount(0);
    await search.fill("");
    await expect(duplicate).toBeDisabled();
    await disclosure.click();
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    const removalRefresh = new Promise<void>((resolve) => {
      releaseEntryRefresh = resolve;
    });
    let refreshingRemoval = false;
    await page.route(
      `**/api/lorebooks/${book.id}/entries`,
      async (route) => {
        refreshingRemoval = true;
        await removalRefresh;
        await route.continue();
      },
      { times: 1 },
    );
    releaseCaptionSave();
    await expect.poll(() => refreshingRemoval).toBe(true);
    await page.screenshot({ path: info.outputPath("duplicate-awaiting-image-removal-refresh.png") });
    await expect(duplicate).toBeDisabled();
    releaseEntryRefresh();
    await expect(references.getByRole("img")).toHaveCount(1);
    await expect.poll(async () => (await readEntry()).images[0].caption).toBe("Saved while removing boots");
    await expect(duplicate).toBeEnabled();
    await duplicate.click();
    await expect
      .poll(async () => {
        const saved = await (await request.get(`/api/lorebooks/${book.id}/entries`)).json();
        return saved.find((candidate: { id: string }) => candidate.id !== entry.id && candidate.id !== copied.id)
          ?.images;
      })
      .toEqual((await readEntry()).images);
    const beforeFailedRemoval = (await readEntry()).images;
    await page.route(
      `**/api/lorebooks/${book.id}/entries/${entry.id}`,
      (route) => route.fulfill({ status: 500, json: { error: "Removal failed" } }),
      { times: 1 },
    );
    await references.getByRole("button", { name: "Remove image" }).last().click();
    await expect(references.getByRole("alert")).toBeVisible();
    await expect(duplicate).toBeEnabled();
    await expect(references.getByRole("img")).toHaveCount(1);
    await expect(references.getByRole("textbox", { name: "Caption" })).toHaveValue(beforeFailedRemoval[0].caption);
    expect((await readEntry()).images).toEqual(beforeFailedRemoval);
    await page.screenshot({ path: info.outputPath("references-failed-removal.png") });
    const failedUpload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const captionSave = new Promise<void>((resolve) => {
      releaseCaptionSave = resolve;
    });
    let savingCaption = false;
    await page.route(
      `**/api/lorebooks/${book.id}/entries/${entry.id}`,
      async (route) => {
        savingCaption = true;
        await captionSave;
        await route.continue();
      },
      { times: 1 },
    );
    await references.getByRole("textbox", { name: "Caption" }).first().fill("Caption saved before upload");
    await page.route(
      `**/api/lorebooks/${book.id}/entries/${entry.id}/images`,
      async (route) => {
        await failedUpload;
        await route.fulfill({ status: 500, json: { error: "Upload failed" } });
      },
      { times: 1 },
    );
    await references
      .locator('input[type="file"]')
      .setInputFiles({ name: "failed.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => savingCaption).toBe(true);
    await expect(duplicate).toBeDisabled();
    releaseCaptionSave();
    releaseUpload();
    await expect(references.getByRole("alert")).toBeVisible();
    await expect(duplicate).toBeEnabled();
    expect((await readEntry()).images).toHaveLength(1);
    await references
      .locator('input[type="file"]')
      .setInputFiles({ name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(references.getByRole("alert")).toBeVisible();
    await page.screenshot({ path: info.outputPath("references-invalid-file.png") });
    expect((await readEntry()).images).toHaveLength(1);
    const chooseUnknownType = (bytes: number[]) =>
      references.locator('input[type="file"]').evaluate((input: HTMLInputElement, bytes) => {
        const files = new DataTransfer();
        const file = new File([new Uint8Array(bytes)], "unknown-type.png");
        files.items.add(file);
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return file.type;
      }, bytes);
    expect(await chooseUnknownType([...png])).toBe("");
    await page.screenshot({ path: info.outputPath("references-unknown-mime.png") });
    await expect(references.getByRole("img")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("references-unknown-mime-accepted.png") });
    const rejectedUnknown = page.waitForResponse((response) =>
      response.url().endsWith(`/api/lorebooks/${book.id}/entries/${entry.id}/images`),
    );
    expect(await chooseUnknownType([...Buffer.from("not an image")])).toBe("");
    expect((await rejectedUnknown).status()).toBe(400);
    await expect(references.getByRole("alert")).toBeVisible();
    expect((await readEntry()).images).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("references-unknown-mime-rejected.png") });
    await references
      .locator('input[type="file"]')
      .setInputFiles([1, 2].map((number) => ({ name: `reference-${number}.png`, mimeType: "image/png", buffer: png })));
    await expect(references.getByRole("img")).toHaveCount(4);
    await expect(references.getByRole("button", { name: "Add image", exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath("references-limit.png") });
    expect(errors).toEqual([]);
  } finally {
    releaseUpload();
    releaseSecondUpload();
    releaseCaptionSave();
    releaseEntryRefresh();
    await info.attach("browser-diagnostics", {
      body: JSON.stringify(browserDiagnostics),
      contentType: "application/json",
    });
    await page.close();
    await request.delete(`/api/lorebooks/${book.id}`);
  }
});

test("activated wardrobe references reach the provider and unsupported models retry with text", async ({
  request,
}, info) => {
  test.skip(!info.project.name.includes("desktop"), "Provider integration uses one isolated desktop fixture.");
  const requests: Array<{ messages: Array<{ content: unknown }> }> = [];
  let rejectImages = false;
  const provider = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      if (rejectImages && JSON.stringify(body.messages).includes("image_url")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "This model does not support image inputs" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The coat is blue." }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture did not bind");
  let bookId = "",
    characterId = "",
    chatId = "",
    connectionId = "",
    fallbackConnectionId = "";
  try {
    const connection = await (
      await request.post("/api/connections", {
        data: {
          name: "Lorebook vision fixture",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          model: "fixture",
          maxContext: 32768,
        },
      })
    ).json();
    connectionId = connection.id;
    const character = await (
      await request.post("/api/characters", { data: { data: { name: "Tailor", description: "Describe clothes." } } })
    ).json();
    characterId = character.id;
    const book = await (await request.post("/api/lorebooks", { data: { name: "Wardrobe", tokenBudget: 2048 } })).json();
    bookId = book.id;
    const entry = await (
      await request.post(`/api/lorebooks/${bookId}/entries`, {
        data: { name: "Coat", content: "WARDROBE_TEXT: blue velvet coat", keys: ["wardrobe"] },
      })
    ).json();
    const upload = await request.post(`/api/lorebooks/${bookId}/entries/${entry.id}/images`, {
      multipart: { file: { name: "coat.png", mimeType: "image/png", buffer: png } },
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    const images = (await upload.json()).images;
    await request.patch(`/api/lorebooks/${bookId}/entries/${entry.id}`, {
      data: { images: [{ ...images[0], caption: "Silver buttons" }] },
    });
    const chat = await (
      await request.post("/api/chats", {
        data: { name: "Vision wardrobe", mode: "roleplay", characterIds: [characterId], connectionId },
      })
    ).json();
    chatId = chat.id;
    await request.patch(`/api/chats/${chatId}/metadata`, {
      data: { activeLorebookIds: [bookId], enableAgents: false },
    });
    await request.post(`/api/chats/${chatId}/messages`, { data: { role: "user", content: "Inspect my wardrobe" } });
    const dry = await request.post("/api/generate/dryRun", {
      data: { chatId, returnPrompt: true, injectLorebook: true },
    });
    expect(dry.ok(), await dry.text()).toBeTruthy();
    const prompt = (await dry.json()).prompt.messages;
    expect(JSON.stringify(prompt)).toContain("WARDROBE_TEXT");
    expect(prompt.flatMap((m: { images?: string[] }) => m.images ?? [])).toEqual([
      `data:image/png;base64,${png.toString("base64")}`,
    ]);
    const generated = await request.post("/api/generate", { data: { chatId } });
    expect(generated.ok(), await generated.text()).toBeTruthy();
    expect(await generated.text()).not.toContain('"type":"error"');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("image_url");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("WARDROBE_TEXT");
    const backupConnection = await (
      await request.post("/api/connections", {
        data: {
          name: "Fallback must not replace chosen text-only model",
          provider: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          model: "fallback-fixture",
          fallbackForMain: true,
        },
      })
    ).json();
    fallbackConnectionId = backupConnection.id;
    rejectImages = true;
    const before = requests.length;
    const fallback = await request.post("/api/generate", { data: { chatId } });
    const events = await fallback.text();
    expect(events).toContain("lorebook_image_notice");
    expect(events).toContain("unsupported");
    expect(events).not.toContain('"type":"error"');
    expect(events).not.toContain('"type":"generation_fallback"');
    expect(requests.length - before).toBe(2);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("image_url");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Silver buttons");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("WARDROBE_TEXT");
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`);
    if (bookId) await request.delete(`/api/lorebooks/${bookId}`);
    if (characterId) await request.delete(`/api/characters/${characterId}`);
    if (fallbackConnectionId) await request.delete(`/api/connections/${fallbackConnectionId}`);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`);
    await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
  }
});
