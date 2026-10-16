// Compile-time fixture (#1796): checked by `npm run build`, never executed.
// Each @ts-expect-error line must stay an error; if the contract loosens the
// build fails with "Unused '@ts-expect-error' directive".
import type { BrokerInitializeResponse, CodexAppServerClientOptions } from "../../plugins/codex/scripts/lib/app-server-protocol";
import { CodexAppServerClient } from "../../plugins/codex/scripts/lib/app-server.mjs";

// Current broker: reports the app policy.
export const current: BrokerInitializeResponse = { userAgent: "codex-companion-broker", appPolicy: "apps:deny-v1" };
// Legacy broker: no appPolicy at all.
export const legacy: BrokerInitializeResponse = { userAgent: "codex-companion-broker" };
// @ts-expect-error appPolicy must be a string
export const policyNumber: BrokerInitializeResponse = { userAgent: "codex-companion-broker", appPolicy: 1 };
// @ts-expect-error a fresh literal may carry only fields the type names
export const foreignField: BrokerInitializeResponse = { userAgent: "codex-companion-broker", codexHome: "/x" };

// Valid forms (these only prove the options still accept them).
export const denyDefault: CodexAppServerClientOptions = {};
export const denyDirect: CodexAppServerClientOptions = { disableBroker: true };
export const interruptLegacy: CodexAppServerClientOptions = { reuseExistingBroker: true, allowLegacyBroker: true };
// @ts-expect-error allowLegacyBroker is a boolean, a string is truthy by accident
export const legacyString: CodexAppServerClientOptions = { allowLegacyBroker: "false" };

export async function connectChecks() {
  await CodexAppServerClient.connect("/x");
  await CodexAppServerClient.connect("/x", { reuseExistingBroker: true, allowLegacyBroker: true });
  // @ts-expect-error allowLegacyBroker is a boolean at connect too
  await CodexAppServerClient.connect("/x", { allowLegacyBroker: "false" });
}
