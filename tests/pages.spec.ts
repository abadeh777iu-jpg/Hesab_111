import { expect, test } from "@playwright/test";

// Run against a production preview built with VITE_BASE_PATH=/Hesab_111/.
// PAGES_TEST_URL=http://127.0.0.1:3001/Hesab_111/ npm test -- tests/pages.spec.ts
const pagesUrl = process.env.PAGES_TEST_URL;

test("GitHub Pages subpath loads the app, local assets, and navigation", async ({
  page,
}) => {
  test.skip(
    !pagesUrl,
    "Set PAGES_TEST_URL to a project-path production preview.",
  );
  await page.route("https://cdn.sceneai.art/**", (route) => route.abort());
  const failedAssets: string[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(pagesUrl!) && response.status() >= 400) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(pagesUrl!);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Manage your sales and",
  );
  await expect(page).toHaveTitle(
    "Scalable — Manage your sales and analytics in one place",
  );
  const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(favicon).toBe("/Hesab_111/favicon.svg");
  const faviconResponse = await page.request.get(
    new URL(favicon!, pagesUrl!).href,
  );
  expect(faviconResponse.ok()).toBe(true);
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    /^\/Hesab_111\/assets\/ambient-fallback/,
  );
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThan(2);
  await page.getByRole("button", { name: "Book Your Demo" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page.getByRole("link", { name: "Analytics overview" }).click();
  await expect(page).toHaveURL(new URL("#dashboard", pagesUrl!).href);
  expect(failedAssets).toEqual([]);
  expect(errors).toEqual([]);
});
