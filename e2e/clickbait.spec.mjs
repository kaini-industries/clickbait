import { expect, test } from "@playwright/test";
import axeCore from "axe-core";

const V2_KEY = "clickbait-v2";

async function expectNoAccessibilityViolations(page, state) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) {
    await page.addScriptTag({ content: axeCore.source });
  }
  const violations = await page.evaluate(async () => {
    const results = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"],
      },
    });
    return results.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    }));
  });
  expect(violations, `${state} has automated WCAG violations`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("clickbait-e2e-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("clickbait-e2e-initialized", "true");
    }
  });
});

test("rejects signed magnitudes and persists a stamped adjustment immediately", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CLICKBAIT" })).toBeVisible();

  await page.getByRole("button", { name: "type", exact: true }).click();
  const vertical = page.getByLabel(/Vertical offset distance/);
  await vertical.fill("-2");

  await expect(page.getByText(/choose the direction separately/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /I DIALED IT/ })).toHaveCount(0);

  await vertical.fill("2");
  await expect(page.getByText(/8 clicks UP/)).toBeVisible();
  await page.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click();
  await expect(vertical).toBeFocused();

  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        return saved.data.log.length;
      }, V2_KEY),
    )
    .toBe(1);

  await page.reload();
  await page.getByRole("tab", { name: /DOPE LOG/ }).click();
  await expect(page.getByRole("article", { name: /Adjustment for HS507C-X2 at 25 yd/ })).toBeVisible();
});

test("lets a custom distance be erased and retyped without snapping mid-entry", async ({ page }) => {
  await page.goto("/");
  const distance = page.getByLabel("Custom distance in yards");

  await distance.fill("");
  await expect(distance).toHaveValue("");
  await distance.pressSequentially("137");
  await expect(distance).toHaveValue("137");
  await distance.press("Enter");

  await expect
    .poll(() => page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).data.distance : null;
    }, V2_KEY))
    .toBe(137);
});

test("uses the manufacturer rotation convention for the SLx preset", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "SLx 3×32" }).click();
  await page.getByRole("button", { name: "type", exact: true }).click();
  await page.getByLabel(/Vertical offset distance/).fill("1");

  await expect(page.getByText("TURN CLOCKWISE", { exact: true })).toBeVisible();
});

test("announces the physical front-sight action for iron sights", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "AK irons" }).click();
  await page.getByRole("button", { name: "type", exact: true }).click();
  await page.getByLabel(/Vertical offset distance/).fill("5");

  await expect(page.locator("#dial-result-status")).toContainText(/screw the front post down, clockwise from above/i);
});

test("uses entry-specific instructions and waits for a three-shot group", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "type", exact: true }).click();
  await expect(page.locator("#dial-result")).toContainText(/enter the measured shot offset above/i);
  await expect(page.locator("#dial-result")).not.toContainText(/mark it above/i);

  await page.getByRole("button", { name: "tap", exact: true }).click();
  await page.getByRole("button", { name: "group", exact: true }).click();
  const target = page.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("Enter");
  await target.press("ArrowRight");
  await target.press("Enter");
  await expect(page.getByRole("button", { name: /STAMP TO LOG/ })).toHaveCount(0);
  await expect(page.locator("#dial-result")).toContainText(/mark 1 more shot/i);

  await target.dispatchEvent("keydown", { key: "Enter", repeat: true });
  await expect(page.getByText(/2 shots · group 1 in/)).toBeVisible();
  await target.press("ArrowUp");
  await target.press("Enter");
  await expect(page.getByRole("button", { name: "I DIALED IT — STAMP TO LOG" })).toBeVisible();
});

test("commits a built-in profile draft without swallowing the next control click", async ({ page }) => {
  await page.goto("/");
  const target = page.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("ArrowRight");
  await target.press("Enter");
  await expect(page.getByRole("button", { name: "I DIALED IT — NEXT SHOT" })).toBeVisible();
  await page.getByRole("button", { name: "edit specs" }).click();
  await page.getByLabel("MOA per click").fill("");
  await page.getByLabel("Name").click();
  await expect(page.getByLabel("MOA per click")).toHaveValue("1");
  await page.getByLabel("Name").fill("Range optic");
  await page.getByRole("button", { name: "UP = CW", exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        const customs = saved.data.profiles.filter((profile) => !profile.builtin);
        return {
          count: customs.length,
          name: customs[0]?.name,
          elevationRotation: customs[0]?.rot?.UP,
          clickMOA: customs[0]?.clickMOA,
          activeIsCustom: saved.data.activeId === customs[0]?.id,
        };
      }, V2_KEY),
    )
    .toEqual({
      count: 1,
      name: "Range optic",
      elevationRotation: "clockwise",
      clickMOA: 1,
      activeIsCustom: true,
    });
  await expect(page.getByRole("button", { name: /I DIALED IT/ })).toHaveCount(0);
});

test("keeps focus when restoring already-correct preset specifications", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "edit specs" }).click();
  const restore = page.getByRole("button", { name: "restore preset specs" });
  await restore.click();
  await expect(restore).toBeFocused();
});

test("recovers corrupt saved fields without crashing or discarding valid fields", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem(
      "clickbait-v1",
      JSON.stringify({
        units: "not-a-unit",
        distance: 50,
        mode: "group",
        log: [
          {
            id: "legacy-entry",
            ts: 1_700_000_000_000,
            optic: "Recovered optic",
            dist: "50 yd",
            e: "2↑",
            w: "—",
          },
        ],
      }),
    );
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "CLICKBAIT" })).toBeVisible();
  await expect(page.getByRole("button", { name: "group", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use yards and inches" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("tab", { name: /DOPE LOG/ }).click();
  await expect(page.getByRole("article", { name: /Recovered optic at 50 yd/ })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), V2_KEY)).toBe(true);
});

test("does not overwrite a future schema discovered immediately before a commit", async ({ page }) => {
  await page.goto("/");
  const futurePayload = { schemaVersion: 999, sentinel: "keep-this-newer-data" };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: V2_KEY,
    value: futurePayload,
  });

  await page.getByRole("button", { name: "Use meters and centimeters" }).click();
  await expect(page.getByRole("alert", { name: "Saving unavailable" })).toContainText(/newer version.*not being saved/i);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), V2_KEY)).toEqual(futurePayload);
});

test("does not write when the latest storage read fails", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => {
    window.__clickbaitOriginalGetItem = Storage.prototype.getItem;
    window.__clickbaitOriginalSetItem = Storage.prototype.setItem;
    window.__clickbaitWriteAttempts = 0;
    Storage.prototype.getItem = function getItem(storageKey) {
      if (storageKey === key) throw new DOMException("Storage read denied", "SecurityError");
      return window.__clickbaitOriginalGetItem.call(this, storageKey);
    };
    Storage.prototype.setItem = function setItem(...args) {
      window.__clickbaitWriteAttempts += 1;
      return window.__clickbaitOriginalSetItem.apply(this, args);
    };
  }, V2_KEY);

  await page.getByRole("button", { name: "group", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Saving unavailable" })).toContainText(/could not be read/i);
  await expect.poll(() => page.evaluate(() => window.__clickbaitWriteAttempts)).toBe(0);
  await page.evaluate(() => {
    Storage.prototype.getItem = window.__clickbaitOriginalGetItem;
    Storage.prototype.setItem = window.__clickbaitOriginalSetItem;
  });
});

test("keeps working and visibly warns when a storage write fails", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.__clickbaitOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem() {
      throw new DOMException("Storage is full", "QuotaExceededError");
    };
  });

  await page.getByRole("button", { name: "group", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Saving unavailable" })).toContainText(/could not save range data/i);
  await expect(page.getByRole("button", { name: "group", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__clickbaitOriginalSetItem;
  });
  await page.getByRole("button", { name: "one shot", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Saving unavailable" })).toHaveCount(0);
});

test("merges unrelated edits from two open tabs", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();

  await first.goto("/");
  await second.goto("/");

  await first.getByRole("button", { name: "type", exact: true }).click();
  await first.getByLabel(/Vertical offset distance/).fill("2");
  await second.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await Promise.all([
    first.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click(),
    second.getByRole("button", { name: "Add one click" }).click(),
  ]);

  await expect
    .poll(() =>
      first.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        return {
          logs: saved.data.log.length,
          counter: saved.data.counters.hs507c?.ELEVATION?.count ?? 0,
        };
      }, V2_KEY),
    )
    .toEqual({ logs: 1, counter: 1 });

  await context.close();
});

test("discards a pending imperial distance when another tab switches units", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");

  await first.getByLabel("Custom distance in yards").fill("137");
  await second.getByRole("button", { name: "Use meters and centimeters" }).click();

  await expect(first.getByRole("button", { name: "Use meters and centimeters" })).toHaveAttribute("aria-pressed", "true");
  await expect(first.getByLabel("Custom distance in meters")).toHaveValue("50");
  await expect
    .poll(() => first.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      return { units: saved.data.units, distance: saved.data.distance };
    }, V2_KEY))
    .toEqual({ units: "met", distance: 50 });

  await context.close();
});

test("does not clear a shot when reconciling its own pending distance", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");

  const target = first.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("ArrowRight");
  await target.press("Enter");
  await expect(first.getByRole("button", { name: "I DIALED IT — NEXT SHOT" })).toBeVisible();
  await first.getByLabel("Custom distance in yards").fill("137");

  await second.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await second.getByRole("button", { name: "Add one click" }).click();
  await expect(first.getByRole("button", { name: "I DIALED IT — NEXT SHOT" })).toBeVisible();
  await expect(first.getByRole("button", { name: "undo last shot" })).toBeEnabled();
  await expect.poll(() => first.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).data.distance : null;
  }, V2_KEY)).toBe(137);

  await context.close();
});

test("turns storage clearing and primary-key removal into reset generations", async ({ browser }) => {
  const context = await browser.newContext();
  const staleTab = await context.newPage();
  const resettingTab = await context.newPage();
  await staleTab.goto("/");
  await resettingTab.goto("/");

  await staleTab.getByRole("button", { name: "Add custom optic" }).click();
  await staleTab.getByRole("button", { name: "type", exact: true }).click();
  await staleTab.getByLabel(/Vertical offset distance/).fill("1");
  await staleTab.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click();
  await expect.poll(() => staleTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return [saved.data.profiles.length, saved.data.log.length];
  }, V2_KEY)).toEqual([4, 1]);

  await resettingTab.evaluate(() => localStorage.clear());
  await expect.poll(() => resettingTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && {
      profiles: saved.data.profiles.length,
      logs: saved.data.log.length,
      units: saved.data.units,
    };
  }, V2_KEY)).toEqual({ profiles: 3, logs: 0, units: "imp" });

  await resettingTab.getByRole("button", { name: "Use meters and centimeters" }).click();
  await expect.poll(() => staleTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      profiles: saved.data.profiles.length,
      logs: saved.data.log.length,
      units: saved.data.units,
    };
  }, V2_KEY)).toEqual({ profiles: 3, logs: 0, units: "met" });

  await staleTab.getByRole("button", { name: "Add custom optic" }).click();
  await expect.poll(() => staleTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).data.profiles.length : null;
  }, V2_KEY)).toBe(4);
  await resettingTab.evaluate((key) => localStorage.removeItem(key), V2_KEY);
  await expect.poll(() => resettingTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return { profiles: saved.data.profiles.length, logs: saved.data.log.length, units: saved.data.units };
  }, V2_KEY)).toEqual({ profiles: 3, logs: 0, units: "imp" });

  await context.close();
});

test("honors storage removal in the same tab before its next write", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add custom optic" }).click();
  await page.getByRole("button", { name: "type", exact: true }).click();
  await page.getByLabel(/Vertical offset distance/).fill("1");
  await page.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return [saved.data.profiles.length, saved.data.log.length];
  }, V2_KEY)).toEqual([4, 1]);

  await page.evaluate((key) => localStorage.removeItem(key), V2_KEY);
  await page.getByRole("button", { name: "Use meters and centimeters" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      profiles: saved.data.profiles.length,
      logs: saved.data.log.length,
      units: saved.data.units,
    };
  }, V2_KEY)).toEqual({ profiles: 3, logs: 0, units: "met" });
});

test("discards a queued distance draft when same-tab storage is reset", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add custom optic" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).data.profiles.length : null;
  }, V2_KEY)).toBe(4);

  await page.getByLabel("Custom distance in yards").fill("137");
  await page.evaluate((key) => localStorage.removeItem(key), V2_KEY);

  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      profiles: saved.data.profiles.length,
      distance: saved.data.distance,
      span: saved.data.span,
    };
  }, V2_KEY)).toEqual({ profiles: 3, distance: 25, span: 12 });
  await expect(page.getByLabel("Custom distance in yards")).toHaveValue("25");
});

test("applies distance and span edits made after same-tab reset in their visible units", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Use meters and centimeters" }).click();
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), V2_KEY)).toBe(true);

  await page.evaluate((key) => localStorage.removeItem(key), V2_KEY);
  await page.getByRole("button", { name: "60cm" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      profiles: saved.data.profiles.length,
      units: saved.data.units,
      distance: saved.data.distance,
      span: saved.data.span,
    };
  }, V2_KEY)).toEqual({ profiles: 3, units: "met", distance: 50, span: 60 });
  await expect(page.getByRole("button", { name: "60cm" })).toHaveAttribute("aria-pressed", "true");

  await page.evaluate((key) => localStorage.removeItem(key), V2_KEY);
  await page.getByLabel("Custom distance in meters").fill("137");
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return { units: saved.data.units, distance: saved.data.distance, span: saved.data.span };
  }, V2_KEY)).toEqual({ units: "met", distance: 137, span: 30 });
  await expect(page.getByLabel("Custom distance in meters")).toHaveValue("137");
});

test("clears transient shot state when a same-tab reset precedes a counter write", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Use meters and centimeters" }).click();
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), V2_KEY)).toBe(true);

  const target = page.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("ArrowRight");
  await target.press("Enter");
  await expect(page.getByRole("button", { name: "I DIALED IT — NEXT SHOT" })).toBeVisible();

  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await page.evaluate((key) => localStorage.removeItem(key), V2_KEY);
  await page.getByRole("button", { name: "Add one click" }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();

  await page.getByRole("tab", { name: "ZERO TARGET" }).click();
  await expect(page.getByRole("button", { name: "I DIALED IT — NEXT SHOT" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "undo last shot" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use yards and inches" })).toHaveAttribute("aria-pressed", "true");
});

test("does not resurrect a cleared log when a stale tab appends", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const initializationKey = "clickbait-e2e-isolated-context";
    if (!localStorage.getItem(initializationKey)) {
      localStorage.clear();
      localStorage.setItem(initializationKey, "true");
    }
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === "storage") return undefined;
      return originalAddEventListener(type, listener, options);
    };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });

  const clearingTab = await context.newPage();
  await clearingTab.goto("/");
  await clearingTab.getByRole("button", { name: "type", exact: true }).click();
  await clearingTab.getByLabel(/Vertical offset distance/).fill("1");
  await clearingTab.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click();
  await expect.poll(() => clearingTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).data.log.length : null;
  }, V2_KEY)).toBe(1);

  const staleTab = await context.newPage();
  await staleTab.goto("/");
  await clearingTab.getByRole("tab", { name: /DOPE LOG/ }).click();
  await clearingTab.getByRole("button", { name: "clear log" }).click();
  await clearingTab.getByRole("button", { name: "confirm clear log" }).click();
  await expect.poll(() => clearingTab.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).data.log.length : null;
  }, V2_KEY)).toBe(0);

  await staleTab.getByLabel(/Vertical offset distance/).fill("2");
  await staleTab.getByRole("button", { name: "I DIALED IT — NEXT SHOT" }).click();
  await expect
    .poll(() => staleTab.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).data.log.length : null;
    }, V2_KEY))
    .toBe(1);

  await context.close();
});

test("preserves distinct custom optics added concurrently", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const initializationKey = "clickbait-e2e-isolated-profiles";
    if (!localStorage.getItem(initializationKey)) {
      localStorage.clear();
      localStorage.setItem(initializationKey, "true");
    }
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === "storage") return undefined;
      return originalAddEventListener(type, listener, options);
    };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });

  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");

  await Promise.all([
    first.getByRole("button", { name: "Add custom optic" }).click(),
    second.getByRole("button", { name: "Add custom optic" }).click(),
  ]);

  await expect
    .poll(() =>
      first.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        return saved.data.profiles.filter((profile) => !profile.builtin).length;
      }, V2_KEY),
    )
    .toBe(2);

  await context.close();
});

test("repairs a malformed IndexedDB coordination database without dropping an update", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase("clickbait-coordination");
    deletion.onerror = () => reject(deletion.error);
    deletion.onblocked = () => reject(new Error("Coordination database deletion was blocked."));
    deletion.onsuccess = () => {
      const request = indexedDB.open("clickbait-coordination", 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        // Deliberately leave v1 without the expected object store.
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    };
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Add custom optic" }).click();
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw).data.profiles.filter((profile) => !profile.builtin).length;
  }, V2_KEY)).toBe(1);
  await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("clickbait-coordination");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const hasStore = request.result.objectStoreNames.contains("locks");
      request.result.close();
      resolve(hasStore);
    };
  }))).toBe(true);
});

test("restores focus when another tab edits and deletes the active custom optic", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");
  await first.getByRole("button", { name: "Add custom optic" }).click();
  await expect(second.getByRole("button", { name: "Custom 1" })).toHaveAttribute("aria-pressed", "true");

  await second.getByRole("button", { name: "edit specs" }).click();
  await first.getByRole("button", { name: "delete optic" }).click();
  await first.getByRole("button", { name: "cancel" }).focus();
  await second.getByLabel("Name").fill("Remote optic");
  await second.getByLabel("Name").press("Enter");
  await expect(first.getByRole("button", { name: "delete optic" })).toBeFocused();

  await first.getByRole("button", { name: "Remote opti" }).focus();
  await second.getByRole("button", { name: "delete optic" }).click();
  await second.getByRole("button", { name: "confirm delete" }).click();
  await expect(first.getByRole("button", { name: "HS507C-X2" })).toBeFocused();

  await context.close();
});

test("restores entry focus when another tab invalidates a focused result action", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");

  const target = first.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("ArrowRight");
  await target.press("Enter");
  const stamp = first.getByRole("button", { name: "I DIALED IT — NEXT SHOT" });
  await stamp.focus();
  await second.getByRole("button", { name: "Use meters and centimeters" }).click();

  await expect(target).toBeFocused();
  await expect(stamp).toHaveCount(0);
  await context.close();
});

test("restores center-panel focus when another tab changes the active turret optic", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");
  await first.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await first.getByRole("button", { name: "Add one click" }).click();
  await first.getByRole("button", { name: "reset", exact: true }).click();
  await expect(first.getByRole("button", { name: "confirm reset" })).toBeFocused();

  await second.getByRole("button", { name: "SLx 3×32" }).click();
  await expect(first.locator("#panel-center")).toBeFocused();
  await expect(first.getByRole("button", { name: "confirm reset" })).toHaveCount(0);
  await context.close();
});

test("flushes pending distance and target-span edits when the page is hidden", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Custom distance in yards").fill("137");
  await page.getByRole("button", { name: "24in" }).click();

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        return { distance: saved.data.distance, span: saved.data.span };
      }, V2_KEY),
    )
    .toEqual({ distance: 137, span: 24 });

  await page.reload();
  await expect(page.getByLabel("Custom distance in yards")).toHaveValue("137");
  await expect(page.getByRole("button", { name: "24in" })).toHaveAttribute("aria-pressed", "true");
});

test("keeps independent counter sessions by optic and turret and explains odd centers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();

  const addOne = page.getByRole("button", { name: "Add one click" });
  for (let count = 0; count < 3; count += 1) await addOne.click();
  await expect(page.getByLabel("3 clicks counted")).toBeVisible();
  await page.getByRole("button", { name: "DONE — CENTER IT" }).click();
  await expect(page.getByText(/exact mechanical center falls between detents 1 and 2/i)).toBeVisible();

  await page.getByRole("button", { name: "windage", exact: true }).click();
  for (let count = 0; count < 2; count += 1) await addOne.click();
  await expect(page.getByLabel("2 clicks counted")).toBeVisible();
  await page.getByRole("button", { name: "elevation", exact: true }).click();
  await expect(page.getByLabel("3 clicks counted")).toBeVisible();

  await page.getByRole("button", { name: "SLx 3×32" }).click();
  await expect(page.getByLabel("0 clicks counted")).toBeVisible();
  await addOne.click();
  await page.getByRole("button", { name: "HS507C-X2" }).click();
  await expect(page.getByLabel("3 clicks counted")).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await expect(page.getByLabel("3 clicks counted")).toBeVisible();
});

test("serializes simultaneous cross-tab counter clicks", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");
  await first.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await second.getByRole("tab", { name: "CENTER TURRETS" }).click();

  await Promise.all([
    first.getByRole("button", { name: "Add one click" }).click(),
    second.getByRole("button", { name: "Add one click" }).click(),
  ]);
  await expect.poll(() => first.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved.data.counters.hs507c.ELEVATION.count;
  }, V2_KEY)).toBe(2);
  await expect(first.getByLabel("2 clicks counted")).toBeVisible();

  await context.close();
});

test("binds destructive counter reset confirmation to the current optic and turret", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();

  await page.getByRole("button", { name: "reset", exact: true }).click();
  await expect(page.getByRole("group", { name: /Confirm resetting the elevation count/ })).toBeVisible();
  await page.getByRole("button", { name: "windage", exact: true }).click();
  await expect(page.getByRole("button", { name: "windage", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "confirm reset" })).toHaveCount(0);
  await page.getByRole("button", { name: "elevation", exact: true }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();

  await page.getByRole("button", { name: "reset", exact: true }).click();
  await page.getByRole("button", { name: "confirm reset" }).click();
  await expect(page.getByLabel("0 clicks counted")).toBeFocused();
});

test("does not erase a custom optic counter when an active spec option is reselected", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add custom optic" }).click();
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();

  await page.getByRole("tab", { name: "ZERO TARGET" }).click();
  await page.getByRole("button", { name: "marked on turret", exact: true }).first().click();
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();
});

test("preserves a physical counter when custom MOA metadata is corrected", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add custom optic" }).click();
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await page.getByRole("tab", { name: "ZERO TARGET" }).click();
  await page.getByLabel("MOA per click").fill("0.25");
  await page.getByLabel("MOA per click").press("Enter");
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await expect(page.getByLabel("2 clicks counted")).toBeVisible();
});

test("carries both turret counters into a customized built-in optic", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await page.getByRole("button", { name: "Add one click" }).click();
  await page.getByRole("button", { name: "windage", exact: true }).click();
  await page.getByRole("button", { name: "Add one click" }).click();

  await page.getByRole("tab", { name: "ZERO TARGET" }).click();
  await page.getByRole("button", { name: "edit specs" }).click();
  await page.getByLabel("MOA per click").fill("0.5");
  await page.getByLabel("MOA per click").press("Enter");
  await expect.poll(() => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    return JSON.parse(raw).data.activeId.startsWith("custom-");
  }, V2_KEY)).toBe(true);

  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await expect(page.getByLabel("2 clicks counted")).toBeVisible();
  await page.getByRole("button", { name: "windage", exact: true }).click();
  await expect(page.getByLabel("1 click counted")).toBeVisible();
});

test("supports keyboard group entry and does not commit pointer drags", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "group", exact: true }).click();

  const target = page.getByRole("button", { name: /Target coordinate picker/ });
  await target.focus();
  await target.press("ArrowRight");
  await target.press("Enter");
  await target.press("ArrowUp");
  await target.press("Enter");
  await expect(page.getByText(/2 shots · group 1 in/)).toBeVisible();

  await page.getByRole("button", { name: "clear shots" }).click();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText(/^0 shots$/)).toBeVisible();

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByText(/^1 shot$/)).toBeVisible();
});

test("exposes semantic tabs, reflows at 320px, and keeps visible controls touch-sized", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await tabs.first().focus();
  await tabs.first().press("ArrowRight");
  await expect(page.getByRole("tab", { name: "CENTER TURRETS" })).toHaveAttribute("aria-selected", "true");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const undersized = await page.locator("button:visible, input:visible, [role=button]:visible").evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute("aria-label") || element.textContent?.trim(), width: rect.width, height: rect.height };
      })
      .filter(({ width, height }) => width < 44 || height < 44),
  );
  expect(undersized).toEqual([]);
});

test("has no automated WCAG A/AA violations across interactive states", async ({ page }) => {
  await page.goto("/");
  await expectNoAccessibilityViolations(page, "zero target");

  await page.getByRole("button", { name: "edit specs" }).click();
  await expectNoAccessibilityViolations(page, "optic editor");

  await page.getByRole("tab", { name: "CENTER TURRETS" }).click();
  await expectNoAccessibilityViolations(page, "turret center");

  await page.getByRole("tab", { name: /DOPE LOG/ }).click();
  await expectNoAccessibilityViolations(page, "empty dope log");

  await page.getByRole("tab", { name: "ZERO TARGET" }).click();
  await page.getByRole("button", { name: "type", exact: true }).click();
  await page.getByLabel(/Vertical offset distance/).fill("-2");
  await expectNoAccessibilityViolations(page, "manual validation error");
});

test("serves hardened headers, a valid manifest, and a working offline app shell", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "One service-worker check is sufficient.");

  const response = await page.goto("/");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["x-powered-by"]).toBeUndefined();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ name: expect.stringContaining("Clickbait"), display: "standalone", start_url: "/" });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192" }),
    expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512" }),
  ]));

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return true;
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const names = await caches.keys();
        const entries = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
        return entries.flat().some((request) => request.url.includes("/_next/static/"));
      }),
    )
    .toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "CLICKBAIT" })).toBeVisible();
});
