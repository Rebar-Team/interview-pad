import { expect, test } from "@playwright/test";

import { BASE_URL, TEST_EMAIL } from "./rooms";

test("room creation can disable the assistant while keeping its history panel", async ({
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
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText(
      "The assistant is disabled for this room. Chat history is read-only.",
    ),
  ).toBeVisible();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Clear chat" }),
  ).toBeDisabled();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").pop();
  const room = await (await page.request.get(`/api/rooms/${id}`)).json();
  expect(room.assistantEnabled).toBe(false);
  expect(room.writable).toBe(true);
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await page.goto(BASE_URL);
  await page.getByRole("button", { name: "New room", exact: true }).click();
  await expect(toggle).toBeChecked();
});
