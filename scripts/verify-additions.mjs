import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of["/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome"])if(existsSync(p))return p;try{const w=execSync("which chromium || which chromium-browser || which google-chrome",{encoding:"utf8"}).trim().split("\n")[0]?.trim();if(w)return w;}catch{}return undefined;}
const PREVIEW_URL = process.env.PREVIEW_URL || "http://localhost:5180";
const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp";
const shot = (n) => `${SHOT_DIR}/${n}`;

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(PREVIEW_URL);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Reset password", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Send an account request" }).click();
  await page.getByLabel("Full name").fill("Recovery Verification");
  await page.getByLabel("University username (if known)").fill("alex.morgan");
  await page.getByLabel("Contact email").fill("recovery@example.test");
  await page
    .getByLabel("Faculty and student/staff ID")
    .fill("Computer Science, student number 12345");
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click();
  await page.getByRole("heading", { name: "Request received" }).waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Use demo credentials" }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Your account is ready" }).waitFor();
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  await page
    .getByRole("heading", { name: "Upcoming exam", exact: true })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await page.getByText("0 unread", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("0 unread", { exact: true }).waitFor();
  await page.getByLabel("Preview role").selectOption("admin");
  await page
    .getByRole("link", { name: "Account requests", exact: true })
    .click();
  await page.getByRole("cell", { name: "Recovery Verification" }).waitFor();
  await page.getByRole("button", { name: "Review request" }).click();
  await page
    .getByLabel("Administrator note")
    .fill("Identity checked against faculty records. Test request resolved.");
  await page.locator("#field-status").selectOption("resolved");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("heading", { name: "No account requests" }).waitFor();
  await page
    .getByLabel("Request status", { exact: true })
    .selectOption("resolved");
  await page.getByRole("cell", { name: "Recovery Verification" }).waitFor();
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Filter user role").selectOption("student");
  await page.locator("tbody tr").first().waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.locator("tbody tr").count(), 2);
  await page.getByLabel("Select eligible accounts on this page").check();
  await page
    .getByRole("button", { name: "Deactivate selected", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Updated 2 accounts. 0 failed.").waitFor();
  await page.getByLabel("Filter account status").selectOption("false");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("tbody tr").count(), 2);
  await page.getByLabel("Select eligible accounts on this page").check();
  await page
    .getByRole("button", { name: "Activate selected", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Updated 2 accounts. 0 failed.").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Select O6U Administrator").waitFor();
  assert.equal(
    await page.getByLabel("Select O6U Administrator").isDisabled(),
    true,
  );
  await page.getByLabel("Preview role").selectOption("student");
  await page.getByRole("link", { name: "My exams", exact: true }).click();
  await page.getByRole("link", { name: "Begin or resume" }).first().click();
  await page.getByText("Demo browser accepted").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Start or resume exam" })
      .isDisabled(),
    true,
  );
  await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.locator(".question-panel").waitFor();
  await page.getByRole("radio").first().check();
  await page.getByText("Answers synced", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Existing attempt found").waitFor();
  assert.equal(await page.getByLabel("I understand the exam rules").count(), 0);
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  assert.equal(await page.getByRole("radio").first().isChecked(), true);
  await page.getByLabel("Language", { exact: true }).selectOption("ar");
  await page.getByLabel("المظهر", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "الخروج والاستئناف لاحقًا" }).click();
  await page.getByRole("link", { name: "الإشعارات", exact: true }).click();
  await page.getByRole("heading", { name: "الإشعارات", exact: true }).waitFor();
  await page.locator(".notification-list article").first().waitFor();
  await page.screenshot({
    path: shot("o6u-additions-notifications.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "فتح القائمة" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sidebar").getAttribute("inert"), "");
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: shot("o6u-additions-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: demo recovery queue/resolution, notification read persistence, user filters/bulk activation, protected admin selection, readiness rules/resume, Arabic/dark/mobile/Escape, and no browser errors.",
  );
} finally {
  await browser.close();
}
