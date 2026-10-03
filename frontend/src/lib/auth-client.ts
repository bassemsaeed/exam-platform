import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

// Must mirror the server: displayUsername:false (no extra column).
// baseURL points at Express, NOT the Vite dev server.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:4000",
  plugins: [usernameClient({ displayUsername: false })],
});
export const { signIn, signUp, signOut, useSession } = authClient;
