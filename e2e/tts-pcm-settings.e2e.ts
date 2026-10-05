import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("PCM speech format persists through the settings UI and reload", async ({ page, request }) => {
  const originalResponse = await request.get("/api/tts/config");
  expect(originalResponse.ok()).toBeTruthy();
  const original = await originalResponse.json();
  try {
    const saved = await request.put("/api/tts/config", {
      data: { ...original, enabled: false, source: "openai", audioFormat: "mp3" },
    });
    expect(saved.ok()).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    const openSettings = async () => {
      await page.goto("/");
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().openRightPanel("connections");
      });
      const card = page
        .locator('[data-component="RightPanel"]')
        .getByText("Text to Speech", { exact: true })
        .locator("xpath=../../..");
      await card.getByTitle("Expand").click();
      return card.locator("select").filter({ has: page.locator('option[value="pcm"]') });
    };
    const format = await openSettings();
    await format.selectOption("pcm");
    await expect.poll(async () => (await (await request.get("/api/tts/config")).json()).audioFormat).toBe("pcm");
    const afterReload = await openSettings();
    await expect(afterReload).toHaveValue("pcm");
  } finally {
    const restored = await request.put("/api/tts/config", { data: original });
    expect(restored.ok()).toBeTruthy();
  }
});
