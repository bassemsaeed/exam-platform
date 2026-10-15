import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of["/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome"])if(existsSync(p))return p;try{const w=execSync("which chromium || which chromium-browser || which google-chrome",{encoding:"utf8"}).trim().split("\n")[0]?.trim();if(w)return w;}catch{}return undefined;}
// Run against a dev server with VITE_SEB_DEV_KEY set to the repository's seeded lab key.
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.STUDENT_URL || "http://localhost:5181";
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(FRONTEND_URL);
  await page.locator("#username").fill("stu8");
  await page.locator("#password").fill("Password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "My exams", exact: true }).click();
  await page.getByRole("link", { name: "Begin or resume" }).first().click();
  await page
    .getByRole("heading", { name: "Ready for your assessment?" })
    .waitFor();
  if (await page.getByLabel("I understand the exam rules").count())
    await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.locator(".question-panel").waitFor();
  await page.getByRole("radio").first().check();
  await page.getByText("Answers synced", { exact: true }).waitFor();
  if (await page.getByRole("button", { name: "Flag for review" }).count())
    await page.getByRole("button", { name: "Flag for review" }).first().click();
  await page.getByRole("button", { name: "Flagged for review" }).waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Ready for your assessment?" })
    .waitFor();
  if (await page.getByLabel("I understand the exam rules").count())
    await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.locator(".question-panel").waitFor();
  assert.equal(await page.getByRole("radio").first().isChecked(), true);
  for (;;) {
    for (const question of await page.locator(".exam-question").all())
      await question.getByRole("radio").first().check();
    await page.getByText("Answers synced", { exact: true }).waitFor();
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (!(await next.count())) break;
    await next.click();
  }
  await page
    .getByRole("button", { name: "Submit assessment", exact: true })
    .first().click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("heading", { name: "Submission complete" }).waitFor();
  await page.getByRole("link", { name: "View my results" }).click();
  await page.locator("table tbody tr").first().waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real exam start, PostgreSQL answer/flag persistence, reload resume, final server grading, and results. Development-only SEB key used; production gate unchanged.",
  );
} finally {
  await browser.close();
}
