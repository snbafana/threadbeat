import { hasModalCredentials } from "../src/auth.js";
import { skipSmoke, skipUnless } from "./script-output-utils.js";

export const skipUnlessModalCredentials = (smokeName: string): void => {
  if (!hasModalCredentials(process.env)) {
    skipSmoke(`${smokeName} skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set`);
  }
};

export function skipUnlessGitHubToken(token: string | undefined, smokeName: string): asserts token is string {
  skipUnless(token, `${smokeName} skipped: gh auth token is not available`);
}
