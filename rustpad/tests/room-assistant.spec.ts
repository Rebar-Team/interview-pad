import { expect, test } from "@playwright/test";

import { BASE_URL, TEST_EMAIL } from "./rooms";

test("room creation hides the disabled assistant sidebar", async ({
  page,
}) => {
  await page.goto(`${BASE_URL}/auth/dev?email=${TEST_EMAIL}&next=/`);
  await page.getByRole("button", { name: "New room", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Enable assistant" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("No assistant");
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/r\//);
  await page.getByRole("dialog").getByRole("textbox").fill("Ada");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Rebar Interview Assistant",
  });
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").pop();
  const room = await (await page.request.get(`/api/rooms/${id}`)).json();
  expect(room.assistantEnabled).toBe(false);
  expect(room.writable).toBe(true);
  await page.reload();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect(panel).toHaveCount(0);
  await page.goto(BASE_URL);
  await page.getByRole("button", { name: "New room", exact: true }).click();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/r\//);
  await expect(panel).toBeVisible();
  const enabledId = new URL(page.url()).pathname.split("/").pop();
  await page.route(`**/api/rooms/${enabledId}`, async (route) => {
    const response = await route.fetch();
    const room = await response.json();
    await route.fulfill({ response, json: { ...room, assistant: false } });
  });
  await page.reload();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect(panel).toHaveCount(0);
});
