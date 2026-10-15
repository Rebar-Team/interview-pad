import { expect, test } from "@playwright/test";

import { TEST_EMAIL, createRoom } from "./rooms";

test("signed-out home shows Google sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("wrong-domain sign-in error is explained", async ({ page }) => {
  await page.goto("/?auth_error=domain");
  await expect(
    page.getByText("Use your withrebar.ai Google account."),
  ).toBeVisible();
});

test("dashboard creates a room and lands in it", async ({ page }) => {
  const pairing = `Playwright Pairing ${Date.now()}`;
  await page.goto(
    `/auth/dev?${new URLSearchParams({ email: TEST_EMAIL, next: "/" })}`,
  );
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();

  await page.getByRole("button", { name: "New room" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).not.toHaveValue("");
  await input.fill(pairing);
  await page.getByRole("button", { name: "Create room" }).click();

  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]+$/);
  await expect(page.getByText(pairing)).toBeVisible();
  await expect(page.getByText(/\d+h \d+m left/)).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("cell", { name: pairing }).first()).toBeVisible();
});

test("unknown rooms and legacy hash links show not found", async ({ page }) => {
  await page.goto("/#doesNotExist1");
  await expect(page).toHaveURL(/\/r\/doesNotExist1$/);
  await expect(page.getByText("Room not found")).toBeVisible();
});

test("first Run reaches the runner even while the terminal connects", async ({
  page,
}) => {
  const received: { t: string }[] = [];
  await page.routeWebSocket("**/pty/**", (socket) => {
    socket.onMessage((message) => received.push(JSON.parse(String(message))));
  });
  const id = await createRoom("Run Check");
  await page.goto(`/r/${id}`);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Ada");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.type("print('x')");
  await page.getByRole("button", { name: "Run" }).click();
  await expect
    .poll(() => received.map((m) => m.t))
    .toEqual(expect.arrayContaining(["shell", "run"]));
});
