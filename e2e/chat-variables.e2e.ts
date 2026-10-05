import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// Queued variable edits must target the last successfully saved name, including
// when a preceding rename fails. Hold real requests to exercise that ordering.
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const record = (value: unknown): Record<string, any> => (typeof value === "string" ? JSON.parse(value) : (value ?? {}));

type Gate = { release: () => void; started: () => boolean };

async function openChatVariables(page: import("@playwright/test").Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["roleplay"],
    chatSettingsExpandedSections: { "roleplay-chat-variables": true },
  });
  await page.addInitScript(
    ({ id, seenVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", seenVersion);
    },
    { id: chatId, seenVersion: version },
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    useChatStore.getState().setShouldOpenSettings(true);
  });
  const drawer = page.locator(".mari-chat-settings-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}

// Holds the first metadata PATCH so a second operation is queued behind it.
async function holdFirstMetadataPatch(
  page: import("@playwright/test").Page,
  chatId: string,
  fail = false,
  afterFirst?: () => Promise<void>,
): Promise<Gate> {
  let started = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/chats/${chatId}/metadata`, async (route) => {
    const request = route.request();
    const body = request.method() === "PATCH" ? request.postDataJSON() : null;
    if (body && Object.hasOwn(body, "macroVariables") && !held) {
      held = true;
      started = true;
      await gate;
      if (fail) return route.fulfill({ status: 503, json: { error: "Synthetic rename failure" } });
      if (afterFirst) {
        const response = await route.fetch();
        await afterFirst();
        return route.fulfill({ response });
      }
    }
    await route.continue();
  });
  return { release: () => release(), started: () => started };
}

const createChat = async (request: import("@playwright/test").APIRequestContext, name: string) => {
  const created = await request.post("/api/chats", { data: { name, mode: "roleplay", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { id: string };
};

const storedVariables = async (request: import("@playwright/test").APIRequestContext, chatId: string) =>
  record((await (await request.get(`/api/chats/${chatId}`)).json()).metadata).macroVariables ?? {};

// Removing asks first (#6942); this answers the question.
const confirmRemoval = async (page: import("@playwright/test").Page) =>
  page
    .getByRole("dialog", { name: "Remove variable", exact: true })
    .getByRole("button", { name: "Remove", exact: true })
    .click();

test("a new variable row validates only after the user starts editing", async ({ page, request }) => {
  const chat = await createChat(request, "New variable validation");
  const drawer = await openChatVariables(page, chat.id);
  await drawer.getByRole("button", { name: "Add variable", exact: true }).click();
  const name = drawer.getByLabel("Variable name");
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await name.fill("bad name");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.fill("hero");
  await expect(name).toHaveAttribute("aria-invalid", "false");
});

test("removing a variable asks first, and only a confirmed removal is saved", async ({ page, request }) => {
  const chat = await createChat(request, "Confirm variable removal");
  try {
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
    const drawer = await openChatVariables(page, chat.id);
    const row = drawer.locator('[data-chat-variable-row="char1"]');
    const dialog = page.getByRole("dialog", { name: "Remove variable", exact: true });

    // A stray tap only opens the question, and backing out keeps the variable.
    await row.getByRole("button", { name: "Remove variable" }).click();
    await expect(dialog).toContainText('Remove "char1" from this chat?');
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
    expect(await storedVariables(request, chat.id)).toEqual({ char1: "Mary" });

    await row.getByRole("button", { name: "Remove variable" }).click();
    await confirmRemoval(page);
    await expect(row).toBeHidden();
    await expect.poll(async () => storedVariables(request, chat.id)).toEqual({});
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});

test("a variable saved while the removal question is open is still removed", async ({ page, request }) => {
  const chat = await createChat(request, "Remove while saving");
  let gate: Gate | undefined;
  try {
    const drawer = await openChatVariables(page, chat.id);
    await drawer.getByRole("button", { name: "Add variable", exact: true }).click();
    const row = drawer.locator("[data-chat-variable-row]").first();
    await row.getByLabel("Variable value").fill("Mary");
    const name = row.getByLabel("Variable name");
    await name.fill("hero");
    gate = await holdFirstMetadataPatch(page, chat.id);
    await name.press("Enter");
    await expect.poll(gate.started).toBe(true);
    await row.getByRole("button", { name: "Remove variable" }).click();
    await expect(page.getByRole("dialog", { name: "Remove variable", exact: true })).toContainText('"hero"');

    // The save lands while the question is open; the answer must remove what it saved.
    gate.release();
    await expect.poll(async () => storedVariables(request, chat.id)).toEqual({ hero: "Mary" });
    await confirmRemoval(page);
    await expect.poll(async () => storedVariables(request, chat.id)).toEqual({});
    await expect(drawer.locator("[data-chat-variable-row]")).toHaveCount(0);
  } finally {
    gate?.release();
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});

test("a delete queued behind a rename targets the renamed variable", async ({ page, request }) => {
  const chat = await createChat(request, "Queued rename then delete");
  await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="char1"]');
  await expect(row).toBeVisible();

  const gate = await holdFirstMetadataPatch(page, chat.id);
  const name = row.getByLabel("Variable name");
  await name.fill("lead");
  await name.press("Enter");
  await expect.poll(gate.started).toBe(true);

  // The rename is still in flight; removing the row must drop `lead`, not `char1`.
  await drawer.locator("[data-chat-variable-row]").first().getByRole("button", { name: "Remove variable" }).click();
  await confirmRemoval(page);
  gate.release();

  await expect.poll(async () => await storedVariables(request, chat.id)).toEqual({});
});

test("a second rename queued behind the first drops the intermediate name", async ({ page, request }) => {
  const chat = await createChat(request, "Queued double rename");
  await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="char1"]');
  await expect(row).toBeVisible();

  const gate = await holdFirstMetadataPatch(page, chat.id);
  const name = drawer.locator("[data-chat-variable-row]").first().getByLabel("Variable name");
  await name.fill("lead");
  await name.press("Enter");
  await expect.poll(gate.started).toBe(true);
  await name.fill("hero");
  await name.press("Enter");
  gate.release();

  // `lead` must not survive as an orphan alongside `hero`.
  await expect.poll(async () => await storedVariables(request, chat.id)).toEqual({ hero: "Mary" });
});

test("a value edit is sent for a name only {{setvar}} could have created", async ({ page, request }) => {
  const chat = await createChat(request, "Legacy setvar name");
  // The metadata route refuses to *create* a dotted name, because a bare
  // {{story.day}} could never resolve — only {{setvar}} inside a prompt can put
  // one in a chat. So the fixture injects it into the chat the client reads, and
  // the assertion is on the request the editor makes: the server side of this is
  // already covered by scripts/regressions/chat-variables-persistence.
  await page.route(`**/api/chats/${chat.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { metadata?: unknown };
    const metadata = record(body.metadata);
    await route.fulfill({
      response,
      json: { ...body, metadata: { ...metadata, macroVariables: { "story.day": "3" } } },
    });
  });
  // The app patches unrelated metadata (a background, say) on startup, so keep
  // only the writes this section makes.
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/chats/${chat.id}/metadata`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (body && Object.prototype.hasOwnProperty.call(body, "macroVariables")) patches.push(body);
    }
    await route.continue();
  });

  const drawer = await openChatVariables(page, chat.id);
  const row = drawer.locator('[data-chat-variable-row="story.day"]');
  await expect(row).toBeVisible();
  await expect(row.getByLabel("Variable name")).toHaveAttribute("aria-invalid", "false");

  const value = row.getByLabel("Variable value");
  await value.fill("4");
  await value.press("Enter");

  await expect.poll(() => patches).toEqual([{ macroVariables: { "story.day": "4" } }]);
});

for (const action of ["delete", "rename"] as const) {
  test(`a ${action} queued behind a failed rename targets the saved variable`, async ({ page, request }) => {
    const chat = await createChat(request, "Failed queued rename");
    let gate: Gate | undefined;
    try {
      await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
      const drawer = await openChatVariables(page, chat.id);
      const name = drawer.locator("[data-chat-variable-row]").first().getByLabel("Variable name");
      await expect(name).toHaveValue("char1");
      gate = await holdFirstMetadataPatch(page, chat.id, true);
      await name.fill("lead");
      await name.press("Enter");
      await expect.poll(gate.started).toBe(true);
      if (action === "delete") {
        await drawer
          .locator("[data-chat-variable-row]")
          .first()
          .getByRole("button", { name: "Remove variable" })
          .click();
        await confirmRemoval(page);
      } else {
        await name.fill("hero");
        await name.press("Enter");
      }
      gate.release();
      await expect
        .poll(async () => storedVariables(request, chat.id))
        .toEqual(action === "delete" ? {} : { hero: "Mary" });
    } finally {
      gate?.release();
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
}

test("a queued delete preserves an independently recreated original name", async ({ page, request }) => {
  const chat = await createChat(request, "Recreated variable during rename");
  let gate: Gate | undefined;
  try {
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
    const drawer = await openChatVariables(page, chat.id);
    const name = drawer.locator("[data-chat-variable-row]").first().getByLabel("Variable name");
    await expect(name).toHaveValue("char1");
    gate = await holdFirstMetadataPatch(page, chat.id, false, async () => {
      const recreated = await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: { macroVariables: { char1: "Another character" } },
      });
      expect(recreated.ok()).toBeTruthy();
    });
    await name.fill("lead");
    await name.press("Enter");
    await expect.poll(gate.started).toBe(true);
    await drawer.locator("[data-chat-variable-row]").first().getByRole("button", { name: "Remove variable" }).click();
    await confirmRemoval(page);
    gate.release();
    await expect.poll(async () => storedVariables(request, chat.id)).toEqual({ char1: "Another character" });
  } finally {
    gate?.release();
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});

test("a value reverted while a save is pending still persists the latest edit", async ({ page, request }) => {
  const chat = await createChat(request, "Reverted pending variable edit");
  let gate: Gate | undefined;
  try {
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { macroVariables: { char1: "Mary" } } });
    const drawer = await openChatVariables(page, chat.id);
    const value = drawer.locator("[data-chat-variable-row]").first().getByLabel("Variable value");
    await expect(value).toHaveValue("Mary");
    gate = await holdFirstMetadataPatch(page, chat.id);
    await value.fill("Anna");
    await value.press("Enter");
    await expect.poll(gate.started).toBe(true);
    await value.fill("Mary");
    await value.press("Enter");
    const firstSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chats/${chat.id}/metadata`) && response.request().method() === "PATCH",
    );
    gate.release();
    await firstSaved;
    await expect.poll(async () => storedVariables(request, chat.id)).toEqual({ char1: "Mary" });
    await value.press("Tab");
    await expect(value).toHaveValue("Mary");
  } finally {
    gate?.release();
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
