import { chromium, request as makeRequest } from "playwright";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
function chromiumPath(){if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;for(const p of["/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome"])if(existsSync(p))return p;try{const w=execSync("which chromium || which chromium-browser || which google-chrome",{encoding:"utf8"}).trim().split("\n")[0]?.trim();if(w)return w;}catch{}return undefined;}
const base = process.env.BASE_URL || process.env.API_URL || "http://localhost:4000";
const admin = await makeRequest.newContext({ baseURL: base });
const student = await makeRequest.newContext({ baseURL: base });
const anonymous = await makeRequest.newContext({ baseURL: base });
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const body = {
    kind: "password",
    name: "Workflow verification",
    username: "stu7",
    contact: "verification@example.test",
    details: "Test request: faculty verification required.",
  };
  const send = await anonymous.post("/api/v1/support/requests", { data: body });
  assert.equal(send.status(), 202);
  assert.match((await send.json()).reference, /^[A-F0-9]{8}$/);
  const unknown = await anonymous.post("/api/v1/support/requests", {
    data: { ...body, username: "nonexistentverification" },
  });
  assert.equal(unknown.status(), 202);
  assert.deepEqual(Object.keys(await unknown.json()), ["reference"]);
  assert.equal((await anonymous.get("/api/v1/admin/support")).status(), 401);
  assert.equal(
    (
      await admin.post("/api/auth/sign-in/username", {
        data: { username: "admin1", password: "Password123" },
      })
    ).status(),
    200,
  );
  assert.equal(
    (
      await student.post("/api/auth/sign-in/username", {
        data: { username: "stu6", password: "Password123" },
      })
    ).status(),
    200,
  );
  assert.equal((await student.get("/api/v1/admin/support")).status(), 403);
  const requests = await (
    await admin.get("/api/v1/admin/support?status=pending&limit=100")
  ).json();
  const matching = requests.rows.filter(
    (r) => r.name === "Workflow verification",
  );
  assert.ok(matching.length >= 2);
  for (const r of matching) {
    assert.equal(
      (
        await admin.patch("/api/v1/admin/support/" + r.id, {
          data: {
            status: "resolved",
            adminNote: "Test completed; no password was changed.",
          },
        })
      ).status(),
      200,
    );
  }
  const notices = await (await student.get("/api/v1/notifications")).json();
  assert.ok(Array.isArray(notices));
  assert.ok(!JSON.stringify(notices).includes("correctAnswer"));
  if (notices.length) {
    assert.equal(
      (
        await student.post("/api/v1/notifications/read", {
          data: { keys: [notices[0].key] },
        })
      ).status(),
      200,
    );
    const again = await (await student.get("/api/v1/notifications")).json();
    assert.equal(again.find((n) => n.key === notices[0].key).read, true);
  }
  const examPath = "/api/v1/student/exams";
  const headers = (path) => ({
    "X-SafeExamBrowser-RequestHash": createHash("sha256")
      .update(base + path + "dev-frontend-lab-key-please-rotate")
      .digest("hex"),
  });
  const exams = await (
    await student.get(examPath, { headers: headers(examPath) })
  ).json();
  assert.ok(exams.length);
  const preflight = "/api/v1/student/exams/" + exams[0].id + "/readiness";
  assert.equal((await student.get(preflight)).status(), 403);
  const response = await student.get(preflight, {
    headers: headers(preflight),
  });
  assert.equal(response.status(), 200);
  const ready = await response.json();
  assert.equal(ready.ready, true);
  assert.equal(ready.resumable, false);
  assert.ok(!JSON.stringify(ready).includes("accessCodeHash"));
  assert.ok(!JSON.stringify(ready).includes("questions"));
  const outsider = await makeRequest.newContext({ baseURL: base });
  await outsider.post("/api/auth/sign-in/username", {
    data: { username: "doc1", password: "Password123" },
  });
  assert.equal(
    (await outsider.get(preflight, { headers: headers(preflight) })).status(),
    403,
  );
  await outsider.dispose();
  await page.goto(base);
  await page.locator("#username").fill("admin1");
  await page.locator("#password").fill("Password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome, Admin." }).waitFor();
  await page.goto(base + "/admin/users?search=stu7");
  await page.locator("tbody tr").first().waitFor();
  const user = await (
    await admin.get("/api/v1/admin/users?search=stu7")
  ).json();
  assert.equal(user.rows.length, 1);
  const original = user.rows[0].isActive;
  try {
    await page.getByLabel("Select eligible accounts on this page").check();
    await page
      .getByRole("button", { name: "Deactivate selected", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Updated 1 accounts. 0 failed.").waitFor();
    assert.equal(
      (await (await admin.get("/api/v1/admin/users/" + user.rows[0].id)).json())
        .isActive,
      false,
    );
    await page.getByLabel("Select eligible accounts on this page").check();
    await page
      .getByRole("button", { name: "Activate selected", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByText("Updated 1 accounts. 0 failed.").waitFor();
    assert.equal(
      (await (await admin.get("/api/v1/admin/users/" + user.rows[0].id)).json())
        .isActive,
      true,
    );
  } finally {
    await admin.patch("/api/v1/admin/users/" + user.rows[0].id, {
      data: { isActive: original },
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real support persistence and generic acknowledgements; admin-only queue; user-scoped notification receipts; SEB/role-protected read-only preflight; real filtered bulk activation and restoration.",
  );
} finally {
  await browser.close();
  await Promise.all([admin.dispose(), student.dispose(), anonymous.dispose()]);
}
