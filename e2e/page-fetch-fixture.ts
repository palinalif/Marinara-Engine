import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __marinaraE2EFetches?: { pending: number; lastChange: number };
  }
}

/**
 * Count the page's own fetches from inside the page, in every document it loads.
 *
 * Register before the first navigation. Counted in the page rather than from
 * Playwright's request events: a fetch the app cancels itself does not always report a
 * finished or failed request there, and one missing event would leave the page looking
 * busy for ever.
 */
export async function trackPageFetches(page: Page) {
  await page.addInitScript(() => {
    const state = { pending: 0, lastChange: Date.now() };
    window.__marinaraE2EFetches = state;
    const fetch = window.fetch.bind(window);
    const settle = () => {
      state.pending -= 1;
      state.lastChange = Date.now();
    };
    window.fetch = (input, init) => {
      state.pending += 1;
      state.lastChange = Date.now();
      return fetch(input, init).then(
        (response) => {
          // The headers are not the end of a fetch: its body is still arriving, and a
          // reload cuts that off too. A clone's body ends when the network body does,
          // whether or not the page ever reads its own copy.
          response.clone().arrayBuffer().then(settle, settle);
          return response;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      );
    };
  });
}

/**
 * Wait until none of the page's fetches is pending, bodies included, and none has
 * started or ended for `quietMs`, so a reload does not cut one off.
 *
 * WebKit reports every fetch a reload cuts off as an "access control checks" page error.
 * `page.waitForLoadState("networkidle")` cannot guard that: once a document has been
 * idle, it resolves at once for the rest of that document's life.
 */
export async function waitForPageFetchesToSettle(page: Page, quietMs = 500) {
  await expect
    .poll(
      () =>
        page.evaluate((quietMs) => {
          const fetches = window.__marinaraE2EFetches;
          if (!fetches) throw new Error("trackPageFetches(page) must run before the page loads");
          return fetches.pending === 0 && Date.now() - fetches.lastChange >= quietMs;
        }, quietMs),
      { timeout: 15_000, message: "the page's fetches never settled" },
    )
    .toBe(true);
}
