import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

// Must mirror the server: displayUsername:false (no extra column).
// Default to the browser origin: Express serves production assets and Vite proxies the API in development.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL || window.location.origin,
  plugins: [usernameClient({ displayUsername: false })],
});
export const { signIn, signUp, signOut, useSession } = authClient;
