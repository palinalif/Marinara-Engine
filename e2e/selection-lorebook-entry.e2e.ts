import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("selected chat text becomes a lorebook entry on desktop and mobile (#6899)", async ({
  page,
  request,
}, testInfo) => {
  const book = await (await request.post("/api/lorebooks", { data: { name: "Selection lore" } })).json();
  // Enough existing entries that the new one opens below the fold unless the editor keeps it in view.
  for (let index = 1; index <= 30; index++) {
    await request.post(`/api/lorebooks/${book.id}/entries`, {
      data: { name: `Existing ${String(index).padStart(2, "0")}`, content: "Filler." },
    });
  }
  const chat = await (
    await request.post("/api/chats", { data: { name: "Selection lore chat", mode: "roleplay", characterIds: [] } })
  ).json();
  const message = await (
    await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "The Silver Keep stands above the harbor." },
    })
  ).json();
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript(
      ({ version, chatId }) => {
        localStorage.setItem("marinara:whats-new:seen-version", version);
        localStorage.setItem("marinara-active-chat-id", chatId);
      },
      { version, chatId: chat.id },
    );
    await page.goto("/");

    const messageText = page.locator(`[data-message-id="${message.id}"]`).getByText("The Silver Keep stands");
    await expect(messageText).toBeVisible();
    await messageText.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf("Silver Keep") ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "Silver Keep".length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return;
      }
    });

    const touch = testInfo.project.name.includes("mobile");
    const addButton = page.getByRole("button", { name: "Add to lorebook", exact: true });
    if (!touch) {
      // From the keyboard, the picker takes focus and hands it back when dismissed.
      await addButton.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(addButton).toBeFocused();
    }
    await (touch ? addButton.tap() : addButton.click());
    const bookItem = page.getByRole("menuitem", { name: "Selection lore", exact: true });
    await (touch ? bookItem.tap() : bookItem.click());

    let entryId = "";
    await expect
      .poll(async () => {
        const entries = (await (await request.get(`/api/lorebooks/${book.id}/entries`)).json()) as Array<{
          id: string;
          name: string;
          keys: string[];
        }>;
        const created = entries.find((entry) => entry.name === "Silver Keep");
        entryId = created?.id ?? "";
        return created?.keys;
      })
      .toEqual(["Silver Keep"]);
    // The lorebook opens on the new entry, already expanded for its content.
    const row = page.locator(`[data-lorebook-entry-row-id="${entryId}"]`);
    await expect(row).toBeInViewport();
    await expect(row).toContainText("Silver Keep");
    await expect(row.getByRole("button", { name: "Collapse entry", exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/chats/${chat.id}?force=true`).catch(() => undefined);
    await request.delete(`/api/lorebooks/${book.id}`).catch(() => undefined);
  }
});
