import { PublicClientApplication } from "@azure/msal-browser";

// Admin SPA app registration; requests the platform API's scope so tokens
// carry the same audience the API already verifies.
const CLIENT_ID = "af5d701a-28a5-4eec-b282-bbf97c545fc1";
const TENANT_NAME = "karaorcheeauth";

export const API_SCOPE = "api://4a12e0a8-c0b8-4770-a182-0f02626c7dc5/access_as_user";

export const msal = new PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://${TENANT_NAME}.ciamlogin.com/`,
    knownAuthorities: [`${TENANT_NAME}.ciamlogin.com`],
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: { cacheLocation: "localStorage" },
});
