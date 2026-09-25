import { expect, test } from "@playwright/test";

// Avoid depending on the availability of the external video CDN in UI tests.
test.beforeEach(async ({ page }) => {
  await page.route("https://cdn.sceneai.art/**", (route) => route.abort());
  await page.goto("/");
});

test("exact content, metadata, and locally playable fallback", async ({
  page,
}) => {
  await expect(page).toHaveTitle(
    "Scalable — Manage your sales and analytics in one place",
  );
  await expect(
    page.locator('meta[name="description"]').first(),
  ).toHaveAttribute(
    "content",
    "Track custom events, increase form submissions, optimise conversion rates and optimise your sales flow with Scalable.",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Manage your sales andanalytics in one place.",
  );
  await expect(page.locator("h1 em")).toHaveCSS("font-style", "italic");
  await expect(page.getByText("$9,432.25")).toBeVisible();
  await expect(page.getByText("$404,585")).toBeVisible();
  await expect(page.getByText("1,457", { exact: true })).toBeVisible();
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    /ambient-fallback/,
  );
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThan(2);
  await expect(page.locator(".ambient-wrapper")).toHaveClass(/video-ready/);
});

test("dashboard period tabs respond to click and keyboard", async ({
  page,
}) => {
  const monthlyPath = await page
    .locator('path[stroke="url(#revenue-gradient)"]')
    .getAttribute("d");
  await page.getByRole("tab", { name: "Weekly" }).click();
  await expect(page.getByRole("tab", { name: "Weekly" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".chart-x-axis")).toContainText("Mon");
  expect(
    await page
      .locator('path[stroke="url(#revenue-gradient)"]')
      .getAttribute("d"),
  ).not.toBe(monthlyPath);
  await page.getByRole("tab", { name: "Weekly" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Monthly" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Monthly" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("demo form validates and creates a downloadable local brief", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Book Your Demo" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Prepare my demo" }).click();
  await expect(page.getByLabel("Your name")).toBeFocused();
  await page.getByLabel("Your name").fill("Alex Morgan");
  await page.getByLabel("Work email").fill("alex@example.com");
  await page.getByLabel("Company", { exact: true }).fill("Example Company");
  await page.getByLabel("Team size").selectOption("11–50 people");
  await page.getByRole("button", { name: "Prepare my demo" }).click();
  await expect(page.getByText("Your demo brief is ready, Alex.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download demo brief" }).click();
  expect((await download).suggestedFilename()).toBe("scalable-demo-brief.txt");
  await page.getByRole("button", { name: "Edit your details" }).click();
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue(
    "Example Company",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Book Your Demo" }).first(),
  ).toBeFocused();
});

test("navigation, Pages dropdown, and safe demo withdrawal", async ({
  page,
}) => {
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Less noise. More clarity." }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page.getByRole("link", { name: "Analytics overview" }).click();
  await expect(page).toHaveURL(/#dashboard$/);
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByText(/no money can be moved/)).toBeVisible();
});

test("custom video loads, preserves styling, and gracefully handles a missing URL", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Background settings", exact: true })
    .click();
  await page
    .getByLabel("Video link")
    .fill("http://localhost:5173/src/assets/ambient-fallback.mp4");
  await page.getByRole("button", { name: "Apply video" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your ambient video is playing.",
  );
  await expect(page.locator("video")).toHaveCSS("mix-blend-mode", "screen");
  await expect(page.locator("video")).toHaveCSS("filter", "blur(85px)");
  await page
    .getByLabel("Video link")
    .fill("http://localhost:5173/missing-video.mp4");
  await page.getByRole("button", { name: "Apply video" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Playing the local ambient fallback.",
  );
  await page.getByRole("button", { name: "Restore original" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Playing the local ambient fallback.",
  );
});

test("static gradient remains when every video fails", async ({ page }) => {
  await page.route("**/*.mp4", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".ambient-wrapper")).not.toHaveClass(/video-ready/);
  await expect(page.locator(".ambient-fallback")).toHaveCSS("opacity", "1");
  await page
    .getByRole("button", { name: "Background settings", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Using the static gradient fallback.",
  );
});

test("mobile layout stays within viewport and mobile navigation works", async ({
  page,
}) => {
  for (const width of [320, 390, 600, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Pages", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: "Pricing" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Built for your next chapter." }),
  ).toBeVisible();
});

test("reduced motion uses static gradient without autoplay", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.locator(".ambient-fallback")).toBeAttached();
  await page
    .getByRole("button", { name: "Background settings", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Reduced motion is enabled. Showing the static gradient.",
  );
});
