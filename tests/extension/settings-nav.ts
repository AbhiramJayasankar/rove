import type { Page } from "@playwright/test";

/** Opens a Settings section from anywhere: the chat, the Settings overview or another section.
 *  Narrow windows go through the overview list; wide ones use the section rail. */
export async function openSection(page: Page, name: string, labels = { settings: "Settings", all: "All settings" }) {
  const view = page.locator(".settings-page");
  if (!(await view.isVisible())) {
    await page.getByRole("button", { name: labels.settings, exact: true }).click();
    await view.waitFor();
  }
  const rail = page.locator(".settings-rail");
  if (await rail.isVisible()) return rail.getByRole("button", { name, exact: true }).click();
  const back = page.getByRole("button", { name: labels.all, exact: true });
  if (await back.isVisible()) await back.click();
  await page.locator(".settings-groups").getByRole("button", { name, exact: true }).click();
}
