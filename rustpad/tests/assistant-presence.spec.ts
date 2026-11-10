import { expect, test } from "@playwright/test";

import { BASE_URL, createRoom } from "./rooms";

test("drafts are live, separate, and cleared when a participant leaves", async ({
  browser,
}) => {
  const id = await createRoom("Live drafts");
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    for (const [page, name] of [
      [first, "Ada"],
      [second, "Grace"],
    ] as const) {
      await page.goto(`${BASE_URL}/r/${id}`);
      await page.getByRole("dialog").getByRole("textbox").fill(name);
      await page.getByRole("button", { name: "Join", exact: true }).click();
      await expect(page.getByText("(reconnecting)")).toHaveCount(0);
      await expect(
        page.getByText("Your draft is visible to everyone in this room."),
      ).toBeVisible();
    }
    const firstInput = first.getByRole("textbox", {
      name: "Ask Rebar Interview Assistant",
    });
    const secondInput = second.getByRole("textbox", {
      name: "Ask Rebar Interview Assistant",
    });
    const firstPreviews = first.getByLabel("Other participants' drafts");
    const secondPreviews = second.getByLabel("Other participants' drafts");
    await firstInput.fill("Can you explain this loop?");
    await expect(secondPreviews).toContainText("Ada is typing…");
    await expect(secondPreviews).toContainText("Can you explain this loop?");
    await expect(firstPreviews).toHaveCount(0);
    await secondInput.fill("What about an empty list?");
    await expect(firstPreviews).toContainText("What about an empty list?");
    await expect(firstInput).toHaveValue("Can you explain this loop?");
    await second.reload();
    await expect(secondPreviews).toContainText("Can you explain this loop?");
    await expect(firstPreviews).toHaveCount(0);
    await firstInput.fill("");
    await expect(secondPreviews).toHaveCount(0);
    const typing = firstInput.pressSequentially("A continuously typed draft", {
      delay: 80,
    });
    await expect(secondPreviews).toContainText("A cont", { timeout: 1500 });
    await typing;
    await expect(secondPreviews).toContainText("A continuously typed draft");
    await firstContext.close();
    await expect(secondPreviews).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("sidebar width supports dragging, keyboard controls, and reload", async ({
  page,
}) => {
  const id = await createRoom("Resizable assistant");
  await page.goto(`${BASE_URL}/r/${id}`);
  await page.getByRole("dialog").getByRole("textbox").fill("Ada");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Rebar Interview Assistant",
  });
  const handle = page.getByRole("separator", {
    name: "Resize assistant sidebar",
  });
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 100, bounds.y + 100);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "460");
  expect((await panel.boundingBox())!.width).toBe(460);
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", "460");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "440");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "300");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    (await handle.getAttribute("aria-valuemax"))!,
  );
  await page.setViewportSize({ width: 700, height: 600 });
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeLessThanOrEqual(420);
});
