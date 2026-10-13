// Browser-local preview credentials only. Real authentication stays in Better Auth.
const key = "o6u-demo-password-v1";
const iterations = 120_000;
const defaultPassword = "Preview123!";
interface Verifier {
  salt: string;
  hash: string;
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function unhex(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    parseInt(pair, 16),
  );
}
async function derive(password: string, salt: Uint8Array) {
  if (!crypto.subtle) throw new Error("Use HTTPS to update the demo password.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: new Uint8Array(salt),
          iterations,
        },
        material,
        256,
      ),
    ),
  );
}
export function demoPasswordChanged() {
  return localStorage.getItem(key) !== null;
}
export async function verifyDemoPassword(username: string, password: string) {
  if (username.trim().toLowerCase() !== "alex.morgan") return false;
  const saved = localStorage.getItem(key);
  if (!saved) return password === defaultPassword;
  try {
    const verifier: Verifier = JSON.parse(saved);
    if (
      !/^[a-f0-9]{32}$/.test(verifier.salt) ||
      !/^[a-f0-9]{64}$/.test(verifier.hash)
    )
      return false;
    return (await derive(password, unhex(verifier.salt))) === verifier.hash;
  } catch {
    return false;
  }
}
export async function setDemoPassword(password: string) {
  if (password.length < 8)
    throw new Error("Password must contain at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier: Verifier = {
    salt: hex(salt),
    hash: await derive(password, salt),
  };
  // A storage failure must fail the change, not report success.
  localStorage.setItem(key, JSON.stringify(verifier));
}
export async function changeDemoPassword(
  currentPassword: string,
  newPassword: string,
) {
  if (!(await verifyDemoPassword("alex.morgan", currentPassword)))
    throw new Error("The current password is incorrect.");
  await setDemoPassword(newPassword);
}
export function resetDemoPassword() {
  localStorage.removeItem(key);
}
