import { expect, test } from "@playwright/test";

import { BASE_URL, TEST_EMAIL, createRoom } from "./rooms";

test("creator ends interview, candidate is thanked and blocked, team reviews code", async ({
  browser,
}) => {
  const id = await createRoom("End interview check");
  const ownerContext = await browser.newContext();
  const candidateContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const candidate = await candidateContext.newPage();
  const reviewer = await reviewerContext.newPage();
  try {
    await owner.goto(`${BASE_URL}/auth/dev?email=${TEST_EMAIL}&next=/r/${id}`);
    await reviewer.goto(
      `${BASE_URL}/auth/dev?email=reviewer@withrebar.ai&next=/r/${id}`,
    );
    await candidate.goto(`${BASE_URL}/r/${id}`);
    for (const page of [owner, candidate, reviewer]) {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").fill("Interviewer");
      await dialog.getByRole("button", { name: "Join", exact: true }).click();
      await expect(page.locator(".monaco-editor").first()).toBeVisible();
    }
    await expect(
      candidate.getByRole("button", { name: "End interview", exact: true }),
    ).toHaveCount(0);
    await expect(
      reviewer.getByRole("button", { name: "End interview", exact: true }),
    ).toHaveCount(0);
    await candidate.locator(".monaco-editor").first().click();
    await candidate.keyboard.type("print('kept')");
    await expect(owner.locator(".view-lines").first()).toContainText(
      "print('kept')",
    );
    await owner
      .getByRole("button", { name: "End interview", exact: true })
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(candidate.locator(".monaco-editor").first()).toBeVisible();
    await owner
      .getByRole("button", { name: "End interview", exact: true })
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "End interview", exact: true })
      .click();
    await expect(
      candidate.getByRole("heading", {
        name: "Thank you for interviewing with Rebar.",
      }),
    ).toBeVisible();
    await expect(candidate.locator(".monaco-editor")).toHaveCount(0);
    for (const page of [owner, reviewer]) {
      await expect(
        page.getByText("This interview has ended. Code is read-only."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Run", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("combobox", { name: "Language" }),
      ).toBeDisabled();
      await expect(page.locator(".view-lines").first()).toContainText(
        "print('kept')",
      );
    }
    await candidate.reload();
    await expect(
      candidate.getByRole("heading", {
        name: "Thank you for interviewing with Rebar.",
      }),
    ).toBeVisible();
    const direct = await candidate.request.get(`${BASE_URL}/api/text/${id}`);
    expect(direct.status()).toBe(410);
    await owner.reload();
    await expect(
      owner.getByText("This interview has ended. Code is read-only."),
    ).toBeVisible();
    await expect(owner.locator(".view-lines").first()).toContainText(
      "print('kept')",
    );
    await owner.locator(".monaco-editor").first().click();
    await owner.keyboard.type("cannot edit");
    expect(
      await (await owner.request.get(`${BASE_URL}/api/text/${id}`)).text(),
    ).toBe("print('kept')");
  } finally {
    await Promise.all([
      ownerContext.close(),
      candidateContext.close(),
      reviewerContext.close(),
    ]);
  }
});
