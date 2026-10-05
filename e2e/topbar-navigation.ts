import { expect, type Page } from "@playwright/test";

/** Use the same panel action through desktop navigation or the phone More menu. */
export async function clickTopbarPanel(page: Page, panel: string, action: "click" | "tap" = "click") {
  const direct = page.locator(`[data-tour="panel-${panel}"]`);
  const more = page.locator("[data-topbar-more]");
  await expect(direct.or(more).filter({ visible: true })).toHaveCount(1);
  if (await direct.isVisible()) {
    await direct[action]();
    return;
  }
  await expect(more).toBeVisible();
  if ((await more.getAttribute("aria-expanded")) !== "true") await more[action]();
  await page.locator(`[role="menuitem"][data-topbar-panel="${panel}"]`)[action]();
}
