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
  await page.getByRole("button", { name: "Use demo credentials" }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alex." }).waitFor();
  await page.locator(".assessment-list a").first().waitFor();
  await page.screenshot({
    path: shot("o6u-student-dashboard.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "My exams", exact: true }).click();
  await page.getByRole("link", { name: "Begin or resume" }).first().click();
  await page
    .getByRole("heading", { name: "Ready for your assessment?" })
    .waitFor();
  if (await page.getByLabel("I understand the exam rules").count())
    await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.getByRole("heading", { name: "Question 1 of 6" }).waitFor();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Flag for review" }).click();
  await page.getByRole("button", { name: "Flagged for review" }).waitFor();
  await page.getByText("Answers synced", { exact: true }).waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Ready for your assessment?" })
    .waitFor();
  if (await page.getByLabel("I understand the exam rules").count())
    await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.getByRole("heading", { name: "Question 1 of 6" }).waitFor();
  assert.equal(await page.getByRole("radio").first().isChecked(), true);
  for (let i = 0; i < 6; i++) {
    if (i > 0)
      await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("radio").first().check();
  }
  await page.screenshot({
    path: shot("o6u-exam-runner.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Submit assessment", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("heading", { name: "Submission complete" }).waitFor();
  assert.match(await page.locator(".submitted-panel strong").innerText(), /10/);
  await page.getByRole("link", { name: "View my results" }).click();
  await page.getByRole("cell", { name: "10 marks" }).waitFor();
  await page.getByLabel("Preview role").selectOption("doctor");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Ahmed." }).waitFor();
  await page.getByRole("link", { name: "Question bank", exact: true }).click();
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page
    .locator("#field-text")
    .fill("Which constraint prevents duplicate values?");
  await page.locator("#field-options").fill("UNIQUE\nCHECK\nDEFAULT");
  await page.locator("#field-correctAnswer").fill("UNIQUE");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page
    .getByRole("heading", {
      name: "Which constraint prevents duplicate values?",
    })
    .waitFor();
  await page.getByRole("link", { name: "Exams & quizzes" }).click();
  await page.getByRole("link", { name: "Create exam" }).click();
  await page.locator("#subject").selectOption("s1");
  await page.locator("#start").fill("2026-12-01T09:00");
  await page.locator("#end").fill("2026-12-01T11:00");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.getByRole("heading", { name: "Question pool preview" }).waitFor();
  await page.getByLabel("Preview role").selectOption("admin");
  await page.getByRole("button", { name: "Approve exam" }).click();
  await page.locator(".exam-summary .badge-approved").waitFor();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.locator(".assessment-list a").first().waitFor();
  await page.screenshot({
    path: shot("o6u-admin-dashboard.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Departments", exact: true }).click();
  await page.getByRole("button", { name: "Add department" }).click();
  await page.locator("#field-code").fill("EE");
  await page.locator("#field-name").fill("Electrical Engineering");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("cell", { name: "Electrical Engineering" }).waitFor();
  for (const nav of [
    "Users",
    "Subjects",
    "Sections",
    "Academic terms",
    "Assignments",
    "Browser security",
    "Audit log",
    "Exports",
    "My account",
  ]) {
    await page.getByRole("link", { name: nav, exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("alert").count(), 0, nav);
  }
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: shot("o6u-platform-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
  assert.equal(await page.locator(".sidebar.open").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: demo student exam resume/save/flag/submit/results, doctor question creation and exam creation, admin approval and department creation, all admin pages, role switching, mobile navigation, no browser errors.",
  );
} finally {
  await browser.close();
}
