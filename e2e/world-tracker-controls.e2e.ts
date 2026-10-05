import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({ reducedMotion: "reduce" });

for (const theme of ["light", "dark"] as const) {
  test(`World forecast controls sit beside date and time without covering values (${theme})`, async ({
    page,
    request,
    isMobile,
  }, info) => {
    const response = await request.post("/api/chats", {
      data: { name: "World controls fixture", mode: "roleplay", characterIds: [] },
    });
    expect(response.ok()).toBeTruthy();
    const chat = await response.json();
    try {
      expect(
        (
          await request.patch(`/api/chats/${chat.id}/metadata`, {
            data: { enableAgents: true, activeAgentIds: ["world-state"] },
          })
        ).ok(),
      ).toBeTruthy();
      expect(
        (
          await request.patch(`/api/chats/${chat.id}/game-state`, {
            data: {
              manual: true,
              location: "A quiet riverside camp",
              time: "Later evening",
              date: "Unknown",
              temperature: "Warm",
              weather: "Dry",
              worldCustomFields: Array.from({ length: 24 }, (_, index) => ({
                name: `Detail ${index + 1}`,
                value: "A recorded observation along the riverbank.",
              })),
            },
          })
        ).ok(),
      ).toBeTruthy();
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        sidebarOpen: false,
        rightPanelOpen: false,
        trackerPanelEnabled: true,
        trackerPanelOpen: true,
        trackerPanelOpenByChatId: { [chat.id]: true },
        trackerPanelSide: theme === "light" ? "left" : "right",
        ...(theme === "light" && {
          trackerPanelBackgroundColor: "linear-gradient(135deg, #243447, #415a77)",
        }),
        theme,
        appAccentPulseMode: false,
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: chat.id, version },
      );
      await page.goto("/");
      const tracker = page.locator('[data-component="TrackerDataSidebar"]:visible');
      await expect(tracker).toBeVisible({ timeout: 30_000 });
      const temperature = page.getByRole("button", { name: /^Temperature: Warm/ });
      const weather = page.getByRole("button", { name: /^Weather: Dry/ });
      await expect(temperature).toBeVisible();
      await expect(weather).toBeVisible();
      const surfaces = await tracker.evaluate((panel) => {
        const header = panel.querySelector(".mari-tracker-panel-header")!;
        const paint = (element: Element) => {
          const style = getComputedStyle(element);
          return { color: style.backgroundColor, image: style.backgroundImage };
        };
        return { panel: paint(panel), header: paint(header) };
      });
      expect(surfaces.header).toEqual(surfaces.panel);
      if (theme === "light") expect(surfaces.panel.image).toContain("linear-gradient");
      const scrollLayout = await tracker.evaluate(async (panel) => {
        const header = panel.querySelector(".mari-tracker-panel-header")!;
        const scroller =
          panel.querySelector<HTMLElement>(".overflow-y-auto") ??
          panel.closest<HTMLElement>(".mari-tracker-panel-scroll")!;
        const before = header.getBoundingClientRect().top;
        scroller.scrollTop = 80;
        await new Promise(requestAnimationFrame);
        const result = {
          scrolled: scroller.scrollTop,
          headerOffset: Math.abs(header.getBoundingClientRect().top - before),
        };
        scroller.scrollTop = 0;
        return result;
      });
      expect(scrollLayout.scrolled).toBeGreaterThan(0);
      expect(scrollLayout.headerOffset).toBeLessThanOrEqual(1);
      const tapHint = page.getByText("Tap field to edit it", { exact: true });
      if (isMobile) {
        await expect(tapHint).toBeVisible();
        const hintBox = await tapHint.boundingBox();
        const settingsBox = await page
          .getByRole("button", { name: "Open tracker settings", exact: true })
          .boundingBox();
        expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(settingsBox!.x);
        expect(settingsBox!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
      } else {
        await expect(tapHint).toBeHidden();
      }
      await page.screenshot({ path: info.outputPath(`world-controls-${theme}.png`) });
      const expectControlCentered = async (field: Locator, editHint = true) => {
        const control = field.locator(":scope > span[aria-hidden='true']");
        if (isMobile && editHint) {
          await expect(control).toBeHidden();
          return;
        }
        if (editHint) {
          await field.hover();
          await expect(control).toHaveCSS("opacity", "0.7");
        }
        await expect(control).toBeVisible();
        const centerOffset = await field.evaluate((element) => {
          const control = element.querySelector(":scope > span[aria-hidden='true']")!.getBoundingClientRect();
          const button = element.getBoundingClientRect();
          return Math.abs(control.top + control.height / 2 - (button.top + button.height / 2));
        });
        expect(centerOffset).toBeLessThanOrEqual(1);
      };
      const expectControlBeforeValue = async (field: Locator, editHint = true) => {
        await expectControlCentered(field, editHint);
        if (isMobile && editHint) return;
        const boxes = await field.evaluate((element) => {
          const control = element.querySelector(":scope > span[aria-hidden='true']")!.getBoundingClientRect();
          const value = element.firstElementChild!.getBoundingClientRect();
          const button = element.getBoundingClientRect();
          return {
            controlLeft: control.left,
            controlRight: control.right,
            valueLeft: value.left,
            buttonLeft: button.left,
            buttonWidth: button.width,
          };
        });
        expect(boxes.controlLeft - boxes.buttonLeft).toBeLessThan(boxes.buttonWidth / 4);
        expect(boxes.controlRight).toBeLessThanOrEqual(boxes.valueLeft);
      };
      for (const name of [/^Location: A quiet riverside camp/, /^Time: Later evening/, /^Date: Unknown/]) {
        await expectControlCentered(page.getByRole("button", { name }));
      }
      await expectControlBeforeValue(temperature);
      await expectControlBeforeValue(weather);
      if (!isMobile) {
        const timeIcon = await page
          .getByRole("button", { name: /^Time: Later evening/ })
          .locator(":scope > span[aria-hidden='true']")
          .boundingBox();
        const temperatureIcon = await temperature.locator(":scope > span[aria-hidden='true']").boundingBox();
        expect(temperatureIcon!.x).toBeGreaterThan(timeIcon!.x + timeIcon!.width);
        expect(temperatureIcon!.x - timeIcon!.x - timeIcon!.width).toBeLessThan(24);
        await page.screenshot({ path: info.outputPath(`world-controls-${theme}-desktop-edit.png`) });
      }
      if (isMobile) await weather.tap();
      else await weather.click();
      const input = page.getByRole("textbox", { name: "Weather", exact: true });
      const longWeather = "Dry, with occasional gusts sweeping across the riverside camp";
      await input.fill(longWeather);
      await input.press("Enter");
      const state = async () => (await request.get(`/api/chats/${chat.id}/game-state`)).json();
      await expect.poll(async () => (await state()).weather).toBe(longWeather);
      await expectControlBeforeValue(page.getByRole("button", { name: /^Weather: Dry, with occasional/ }));
      await page.getByRole("button", { name: "Open tracker settings", exact: true }).click();
      await expect(page.getByRole("toolbar", { name: "Tracker panel settings", exact: true })).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await page.screenshot({ path: info.outputPath(`world-controls-${theme}-settings.png`) });
      await page.getByRole("button", { name: "Enter tracker lock mode", exact: true }).click();
      await expect(page.getByRole("button", { name: "Exit tracker lock mode", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(tapHint).toBeHidden();
      const lockTemperature = page.getByRole("button", { name: "Lock temperature", exact: true });
      await expectControlBeforeValue(lockTemperature, false);
      await lockTemperature.click();
      const unlockTemperature = page.getByRole("button", { name: "Unlock temperature", exact: true });
      await expect(unlockTemperature).toHaveAttribute("aria-pressed", "true");
      await expectControlBeforeValue(unlockTemperature, false);
      await expect
        .poll(async () =>
          Object.entries((await state()).fieldLocks ?? {}).some(
            ([key, locked]) => key.endsWith("temperature") && locked === true,
          ),
        )
        .toBe(true);
    } finally {
      await page.close();
      await request.delete(`/api/chats/${chat.id}?force=true`);
    }
  });
}
