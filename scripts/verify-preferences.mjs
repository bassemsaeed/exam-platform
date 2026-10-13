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
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(PREVIEW_URL);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByLabel("Language", { exact: true }).selectOption("ar");
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  await page
    .getByRole("heading", { name: "تسجيل الدخول", exact: true })
    .waitFor();
  await page.screenshot({
    path: shot("o6u-arabic-dark-login.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "استخدم بيانات الدخول التجريبية" })
    .click();
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await page.getByRole("heading", { name: "مرحبًا، Alex." }).waitFor();
  await page.getByLabel("الدور التجريبي").selectOption("admin");
  await page.getByRole("link", { name: "المستخدمون", exact: true }).click();
  await page
    .getByRole("heading", { name: "المستخدمون", exact: true })
    .waitFor();
  await page.locator("table tbody tr").first().waitFor();
  await page.screenshot({
    path: shot("o6u-arabic-dark-admin.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "الأقسام", exact: true }).click();
  await page.locator(".page-heading button").click();
  await page.locator("#field-code").fill("ARTEST");
  await page.locator("#field-name").fill("قسم اختبار اللغة");
  // Changing language must not reset an open form or write anything to the API.
  await page
    .getByLabel("اللغة", { exact: true })
    .selectOption("en", { force: true });
  assert.equal(
    await page.locator("#field-name").inputValue(),
    "قسم اختبار اللغة",
  );
  await page.getByLabel("Department name").waitFor();
  await page
    .getByLabel("Language", { exact: true })
    .selectOption("ar", { force: true });
  await page.getByRole("button", { name: "حفظ التغييرات" }).click();
  await page.getByRole("cell", { name: "قسم اختبار اللغة" }).waitFor();
  await page.getByLabel("اللغة", { exact: true }).selectOption("en");
  await page
    .getByRole("heading", { name: "Departments", exact: true })
    .waitFor();
  await page.getByLabel("Theme", { exact: true }).selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByLabel("Preview role").selectOption("student");
  await page.getByRole("link", { name: "My exams", exact: true }).click();
  await page.getByRole("link", { name: "Begin or resume" }).first().click();
  await page
    .getByRole("heading", { name: "Ready for your assessment?" })
    .waitFor();
  if (await page.getByLabel("I understand the exam rules").count())
    await page.getByLabel("I understand the exam rules").check();
  await page.getByRole("button", { name: "Start or resume exam" }).click();
  await page.getByRole("radio").first().check();
  await page.getByText("Answers synced", { exact: true }).waitFor();
  const answerText = await page.getByRole("radio").first().inputValue();
  await page.getByLabel("Language", { exact: true }).selectOption("ar");
  await page.getByRole("heading", { name: /السؤال 1 من/ }).waitFor();
  assert.equal(await page.getByRole("radio").first().isChecked(), true);
  assert.equal(await page.getByRole("radio").first().inputValue(), answerText);
  await page.getByLabel("المظهر", { exact: true }).selectOption("dark");
  await page.screenshot({
    path: shot("o6u-arabic-dark-exam.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "فتح القائمة" }).click();
  await page.getByRole("link", { name: "نظرة عامة", exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: shot("o6u-arabic-dark-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("heading", { name: "مرحبًا، Alex." }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Arabic login/admin CRUD/student exam, RTL mobile, preserved answers, system theme changes, reload persistence, and no browser errors.",
  );
} finally {
  await browser.close();
}
