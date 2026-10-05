import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { clickTopbarPanel } from "./topbar-navigation.js";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

// #6946: the author byline used to claim 24rem and shrink names that had room to show in full.
test("character editor shows the whole name when it fits beside the byline", async ({ page, request }, testInfo) => {
  await page.route("**/api/app-settings/ui", (route) =>
    route.fulfill({ json: route.request().method() === "GET" ? { value: null } : { success: true } }),
  );
  await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), APP_VERSION);
  const name = "Alexandria Nightshade";
  const response = await request.post("/api/characters", {
    data: {
      data: { name, creator: "Professor Mari and the Fatui Research Collective", character_version: "12.34" },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const character = (await response.json()) as { id: string };
  try {
    await page.goto("/");
    await clickTopbarPanel(page, "characters");
    await page.locator(`[data-character-id="${character.id}"]`).getByText(name, { exact: true }).click();
    const titleLine = page.locator(".mari-editor-shell .mari-editor-title-line");
    const nameInput = titleLine.locator(".mari-editor-title-input");
    await expect(nameInput).toHaveValue(name);
    const expectFullName = async () => {
      await expect(titleLine.locator(".mari-editor-byline")).toBeVisible();
      // WebKit counts about 2px of caret room in scrollWidth even when the text fits.
      await expect
        .poll(() => nameInput.evaluate((input) => input.scrollWidth - input.clientWidth))
        .toBeLessThanOrEqual(2);
    };

    if (testInfo.project.name.includes("mobile")) {
      await expectFullName();
      return;
    }
    // Just past the 80rem breakpoint (beside the 320px panel) the header is crowded; wider screens have room to spare.
    const rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const width of [80 * rootFontSize + 321, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await expectFullName();
    }
  } finally {
    await request.delete(`/api/characters/${character.id}`);
  }
});
