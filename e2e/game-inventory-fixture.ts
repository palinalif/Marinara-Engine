import type { Locator, Page } from "@playwright/test";

/**
 * The narration's Inventory button. On a phone it shows only its icon and has no accessible name
 * (#6796), so it is also found by that icon; wherever it has its name, the name finds it.
 */
export function inventoryButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /Inventory/ })
    .or(page.locator("button:has(svg.lucide-package)"))
    .filter({ visible: true })
    .first();
}
