import {
  type Browser,
  type Page,
  type WebSocketRoute,
  expect,
  test,
} from "@playwright/test";

async function join(
  browser: Browser,
  pad: string,
  name: string,
  hue = 140,
  latency = 0,
) {
  const page = await browser.newPage();
  if (latency) {
    await page.routeWebSocket("**/api/socket/**", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) =>
        setTimeout(() => socket.send(message), latency),
      );
      socket.onMessage((message) =>
        setTimeout(() => server.send(message), latency),
      );
    });
  }
  await page.goto(
    `/tests/editor.html?${new URLSearchParams({ pad, name, hue: String(hue) })}`,
  );
  await page.waitForFunction(() => window.pad?.state.connected);
  return page;
}

async function position(page: Page, lineNumber: number, column: number) {
  await page.evaluate((position) => window.pad.editor.setPosition(position), {
    lineNumber,
    column,
  });
}

async function text(page: Page) {
  return page.evaluate(() => window.pad.editor.getValue());
}

async function expectLabelsInViewport(page: Page, count: number) {
  const labels = page.locator(".remote-cursor-label");
  await expect(labels).toHaveCount(count);
  await expect
    .poll(async () =>
      labels.evaluateAll((nodes) => {
        const rects = nodes.map((node) => node.getBoundingClientRect());
        return rects.every(
          (rect) =>
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight,
        );
      }),
    )
    .toBe(true);
}

async function expectLeadingLabel(page: Page, ahead: string, behind: string) {
  await expect
    .poll(() =>
      page.locator(".remote-cursor-labels").evaluate(
        (layer, { ahead, behind }) => {
          const labels = Array.from(
            layer.querySelectorAll<HTMLElement>(".remote-cursor-label"),
          );
          const front = labels.find((label) => label.textContent === ahead)!;
          const back = labels.find((label) => label.textContent === behind)!;
          const a = front.getBoundingClientRect();
          const b = back.getBoundingClientRect();
          const left = Math.max(a.left, b.left);
          const right = Math.min(a.right, b.right);
          if (a.top !== b.top || right <= left) return false;
          // Temporarily enable hit testing to inspect the actual paint order.
          (layer as HTMLElement).style.pointerEvents = "auto";
          try {
            return (
              document.elementFromPoint(
                (left + right) / 2,
                a.top + a.height / 2,
              ) === front
            );
          } finally {
            (layer as HTMLElement).style.removeProperty("pointer-events");
          }
        },
        { ahead, behind },
      ),
    )
    .toBe(true);
}

test("coincident cursors stack and nearby cursors overlap with the leading cursor on top", async ({
  browser,
}, testInfo) => {
  const pad = `overlap-${testInfo.testId}`;
  const observer = await join(browser, pad, "Miguel");
  const alex = await join(browser, pad, "Alex", 200);
  const candidate = await join(browser, pad, "Candidate", 30);
  await expectLabelsInViewport(observer, 2);
  await observer.evaluate(() =>
    window.pad.editor.setValue(
      "function interview() {\n  return 'hello';\n}\n",
    ),
  );
  await expect.poll(() => text(alex)).toContain("hello");
  await expect.poll(() => text(candidate)).toContain("hello");
  for (const page of [observer, alex, candidate]) await position(page, 2, 5);
  await expectLabelsInViewport(observer, 2);
  await expect(
    observer.locator(".remote-cursor-label").first(),
  ).toHaveAttribute("aria-label", /line 2, column 5/);
  await expect(observer.locator(".remote-cursor-label-group")).toHaveCount(1);
  await position(candidate, 2, 6);
  await expect(
    observer.getByRole("listitem", {
      name: "Candidate, line 2, column 6",
      exact: true,
    }),
  ).toBeVisible();
  await expectLabelsInViewport(observer, 2);
  await expectLeadingLabel(observer, "Candidate", "Alex");
  await position(alex, 2, 7);
  await expect(
    observer.getByRole("listitem", {
      name: "Alex, line 2, column 7",
      exact: true,
    }),
  ).toBeVisible();
  await expectLeadingLabel(observer, "Alex", "Candidate");
  // The overlay must not consume clicks intended for the source underneath it.
  expect(
    await observer
      .locator(".remote-cursor-label")
      .first()
      .evaluate((label) => {
        const rect = label.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + 2, rect.y + 2)
            ?.closest(".remote-cursor-labels") === null
        );
      }),
  ).toBe(true);
  await observer.screenshot({
    path: testInfo.outputPath("nearby-cursors.png"),
  });
  await Promise.all([observer.close(), alex.close(), candidate.close()]);
});

test("single and stacked cursor labels show first names", async ({
  browser,
}, testInfo) => {
  const pad = `screenshots-${testInfo.testId}`;
  const observer = await join(browser, pad, "Miguel Nicolas");
  const alex = await join(browser, pad, "Alex Green", 200);
  await observer.evaluate(() =>
    window.pad.editor.setValue(
      [
        "def find_pair(numbers, target):",
        "    seen = {}",
        "",
        "    for index, number in enumerate(numbers):",
        "        complement = target - number",
        "",
        "        if complement in seen:",
        "            return [seen[complement], index]",
        "",
        "        seen[number] = index",
        "",
        "    return []",
      ].join("\n"),
    ),
  );
  await expect.poll(() => text(alex)).toContain("return []");
  await position(alex, 10, 21);
  await expect(
    observer.getByRole("listitem", {
      name: "Alex Green, line 10, column 21",
      exact: true,
    }),
  ).toHaveText("Alex");
  await expectLabelsInViewport(observer, 1);
  await observer.screenshot({ path: testInfo.outputPath("single-label.png") });
  const sam = await join(browser, pad, "Sam Rivera", 30);
  await expect.poll(() => text(sam)).toContain("return []");
  await position(sam, 10, 21);
  await expect(
    observer.getByRole("listitem", {
      name: "Sam Rivera, line 10, column 21",
      exact: true,
    }),
  ).toHaveText("Sam");
  await expectLabelsInViewport(observer, 2);
  await expect(observer.locator(".remote-cursor-label-group")).toHaveCount(1);
  const [first, second] = await observer
    .locator(".remote-cursor-label")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        left: node.getBoundingClientRect().left,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
      })),
    );
  expect(first.left).toBe(second.left);
  expect(second.top - first.bottom).toBe(2);
  await observer.screenshot({
    path: testInfo.outputPath("stacked-labels.png"),
  });
  await position(sam, 10, 22);
  await expect(
    observer.getByRole("listitem", {
      name: "Sam Rivera, line 10, column 22",
      exact: true,
    }),
  ).toBeVisible();
  await expectLeadingLabel(observer, "Sam", "Alex");
  await observer.screenshot({
    path: testInfo.outputPath("one-character-apart.png"),
  });
  await observer.evaluate(async () => {
    window.pad.editor.setPosition({ lineNumber: 1, column: 1 });
    await window.pad.editor.getAction("editor.fold")!.run();
  });
  await expect(observer.locator(".remote-cursor-label")).toHaveCount(0);
  await observer.evaluate(() =>
    window.pad.editor.getAction("editor.unfoldAll")!.run(),
  );
  await expectLabelsInViewport(observer, 2);
  await Promise.all([observer.close(), alex.close(), sam.close()]);
});

test("disconnect clears presence and reconnect rebuilds labels without ghosts", async ({
  browser,
}, testInfo) => {
  const pad = `reconnect-${testInfo.testId}`;
  const observer = await browser.newPage();
  let server: WebSocketRoute;
  await observer.routeWebSocket("**/api/socket/**", (connection) => {
    server = connection.connectToServer();
  });
  await observer.goto(
    `/tests/editor.html?${new URLSearchParams({ pad, name: "Miguel" })}`,
  );
  await observer.waitForFunction(() => window.pad?.state.connected);
  const alex = await join(browser, pad, "Alex Green");
  await expectLabelsInViewport(observer, 1);
  // The server rejects an unknown message and closes the real connection.
  server!.send(JSON.stringify({ Invalid: "disconnect for reconnect test" }));
  await expect(observer.locator(".remote-cursor-label")).toHaveCount(0);
  await expect(observer.locator(".remote-cursor-label")).toHaveText(["Alex"]);
  await expectLabelsInViewport(observer, 1);
  await Promise.all([observer.close(), alex.close()]);
});

test("renames are plain text, multi-cursors have labels, and departures remove them", async ({
  browser,
}, testInfo) => {
  const pad = `presence-${testInfo.testId}`;
  const observer = await join(browser, pad, "Miguel");
  const alex = await join(browser, pad, "Alex");
  await observer.evaluate(() =>
    window.pad.editor.setValue("one\ntwo\nthree\n"),
  );
  await expect.poll(() => text(alex)).toContain("three");
  await alex.evaluate(() => {
    window.pad.client.setInfo({
      name: "<img/src=x/onerror=alert(1)>",
      hue: 250,
    });
    window.pad.editor.setSelections(
      [1, 3].map((line) => ({
        selectionStartLineNumber: line,
        selectionStartColumn: 2,
        positionLineNumber: line,
        positionColumn: 2,
      })),
    );
  });
  await expectLabelsInViewport(observer, 2);
  await expect(observer.locator(".remote-cursor-label").first()).toHaveText(
    "<img/src=x/onerror=alert(1)>",
  );
  await expect(observer.locator(".remote-cursor-label img")).toHaveCount(0);
  await alex.close();
  await expect(observer.locator(".remote-cursor-label")).toHaveCount(0);
  await observer.evaluate(() => window.pad.client.dispose());
  await expect(observer.locator(".remote-cursor-labels")).toHaveCount(0);
  await observer.close();
});

test("labels follow scrolling, wrapping, resize, and theme changes at viewport edges", async ({
  browser,
}, testInfo) => {
  const pad = `viewport-${testInfo.testId}`;
  const observer = await join(browser, pad, "Miguel");
  const alex = await join(
    browser,
    pad,
    "Alexandertheextremelylongfirstnamethatshouldstillfit Green",
    200,
  );
  await observer.evaluate(() =>
    window.pad.editor.setValue(
      Array.from({ length: 60 }, (_, i) => `${i}: ${"code ".repeat(50)}`).join(
        "\n",
      ),
    ),
  );
  await expect.poll(() => text(alex)).toContain("59:");
  await position(alex, 1, 95);
  await expectLabelsInViewport(observer, 1);
  await observer.evaluate(() => window.pad.editor.setScrollTop(600));
  await expect(observer.locator(".remote-cursor-label")).toHaveCount(0);
  await observer.evaluate(() => {
    window.pad.editor.setScrollTop(0);
    window.pad.editor.setScrollLeft(500);
  });
  await expectLabelsInViewport(observer, 1);
  await observer.setViewportSize({ width: 360, height: 300 });
  await observer.evaluate(() => {
    window.pad.setTheme("vs");
    window.pad.editor.updateOptions({ wordWrap: "on" });
    window.pad.editor.setScrollLeft(0);
  });
  await expectLabelsInViewport(observer, 1);
  await observer.screenshot({
    path: testInfo.outputPath("wrapped-cursor.png"),
  });
  await Promise.all([observer.close(), alex.close()]);
});

test("simultaneous buffered typing at the same position converges and publishes the final caret", async ({
  browser,
}, testInfo) => {
  const pad = `typing-${testInfo.testId}`;
  const observer = await join(browser, pad, "Miguel");
  const alex = await join(browser, pad, "Alex", 200, 100);
  const candidate = await join(browser, pad, "Candidate", 30, 100);
  await expectLabelsInViewport(observer, 2);
  await Promise.all(
    (
      [
        [alex, "abc😀"],
        [candidate, "XYZ🦊"],
      ] as const
    ).map(async ([page, value]) => {
      await page.evaluate((value) => {
        for (const char of value)
          window.pad.editor.trigger("keyboard", "type", { text: char });
      }, value);
    }),
  );
  await expect
    .poll(async () =>
      Array.from(await text(observer))
        .sort()
        .join(""),
    )
    .toBe(Array.from("abc😀XYZ🦊").sort().join(""));
  await expect.poll(() => text(alex)).toBe(await text(observer));
  await expect.poll(() => text(candidate)).toBe(await text(observer));
  for (const [page, name] of [
    [alex, "Alex"],
    [candidate, "Candidate"],
  ] as const) {
    await expect
      .poll(async () => {
        const position = await page.evaluate(
          () => window.pad.editor.getPosition()!,
        );
        return observer
          .getByRole("listitem", {
            name: `${name}, line ${position.lineNumber}, column ${position.column}`,
            exact: true,
          })
          .count();
      })
      .toBe(1);
  }
  await expectLabelsInViewport(observer, 2);
  await Promise.all([observer.close(), alex.close(), candidate.close()]);
});
