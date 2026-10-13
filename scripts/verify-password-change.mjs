import { chromium, request } from "playwright";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of["/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome"])if(existsSync(p))return p;try{const w=execSync("which chromium || which chromium-browser || which google-chrome",{encoding:"utf8"}).trim().split("\n")[0]?.trim();if(w)return w;}catch{}return undefined;}
const PREVIEW_URL = process.env.PREVIEW_URL || "http://localhost:5180";
const API_URL = process.env.BASE_URL || process.env.API_URL || "http://localhost:4000";
const SEB_ORIGIN = process.env.FRONTEND_URL || process.env.STUDENT_URL || "http://localhost:5181";
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const signIn = async (password) => {
  await page.locator("#username").fill("alex.morgan");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
};
try {
  await page.goto(PREVIEW_URL);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await signIn("Preview123!");
  await page.getByRole("link", { name: "My account", exact: true }).click();
  await page
    .locator("#field-currentPassword")
    .fill("WrongPassword");
  await page
    .locator("#field-newPassword")
    .fill("ChangedPreview456!");
  await page.getByRole("button", { name: "Update password" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The current password is incorrect." })
    .waitFor();
  await page
    .locator("#field-currentPassword")
    .fill("Preview123!");
  await page.getByRole("button", { name: "Update password" }).click();
  await page.getByText("Password updated.", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#field-currentPassword").inputValue(),
    "",
  );
  assert.equal(
    await page.locator("#field-newPassword").inputValue(),
    "",
  );
  const stored = await page.evaluate(() =>
    localStorage.getItem("o6u-demo-password-v1"),
  );
  assert.ok(stored);
  assert.ok(!stored.includes("ChangedPreview456!"));
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await page.reload();
  await signIn("Preview123!");
  await page.getByRole("alert").waitFor();
  await signIn("ChangedPreview456!");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alex." }).waitFor();
  await page.getByLabel("Preview role").selectOption("admin");
  await page.goto(PREVIEW_URL + "/#/admin/users/preview-student");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await page.locator("#field-password").fill("AdminReset789!");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator("dialog").waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  await signIn("ChangedPreview456!");
  await page.getByRole("alert").waitFor();
  await signIn("AdminReset789!");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alex." }).waitFor();
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reset demo password" }).click();
  await signIn("Preview123!");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Alex." }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: demo rejects wrong current password; change survives logout/reload; old password rejected; new password accepted; no plaintext stored; admin reset syncs login; explicit demo reset restores defaults.",
  );
} finally {
  await browser.close();
}
// Test the existing real password flow separately and restore the seeded credential.
const admin = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { Origin: SEB_ORIGIN } });
const staff = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { Origin: SEB_ORIGIN } });
let changed = false;
try {
  await admin.post("/api/auth/sign-in/username", {
    data: { username: "admin1", password: "Password123" },
  });
  assert.equal(
    (
      await staff.post("/api/auth/sign-in/username", {
        data: { username: "doc4", password: "Password123" },
      })
    ).status(),
    200,
  );
  assert.equal(
    (
      await staff.post("/api/v1/student/change-password", {
        data: {
          currentPassword: "WrongPassword",
          newPassword: "VerifyPassword456!",
        },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await staff.post("/api/v1/student/change-password", {
        data: {
          currentPassword: "Password123",
          newPassword: "VerifyPassword456!",
        },
      })
    ).status(),
    200,
  );
  changed = true;
  await staff.post("/api/auth/sign-out");
  assert.ok(
    (
      await staff.post("/api/auth/sign-in/username", {
        data: { username: "doc4", password: "Password123" },
      })
    ).status() >= 400,
  );
  assert.equal(
    (
      await staff.post("/api/auth/sign-in/username", {
        data: { username: "doc4", password: "VerifyPassword456!" },
      })
    ).status(),
    200,
  );
  console.log(
    "PASS: real backend password change persists; old credential rejected and new credential accepted after logout.",
  );
} finally {
  if (changed) {
    const users = await (
      await admin.get("/api/v1/admin/users?search=doc4")
    ).json();
    const user = users.rows.find((u) => u.username === "doc4");
    assert.ok(user);
    assert.equal(
      (
        await admin.post(`/api/v1/admin/users/${user.id}/reset-password`, {
          data: { password: "Password123" },
        })
      ).status(),
      200,
    );
  }
  await Promise.all([admin.dispose(), staff.dispose()]);
}
