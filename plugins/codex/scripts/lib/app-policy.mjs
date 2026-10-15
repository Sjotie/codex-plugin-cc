// #1796: ChatGPT apps (connectors, the `codex_apps` MCP server) are off for every
// Codex child this plugin starts. The `apps` feature is stable and on by default
// in codex 0.162.1, also with an empty CODEX_HOME or `--ignore-user-config`, so an
// agent run inherited every connector of the logged-in account (a live customer
// app was called from an eval). `-c features.apps=false` on the process wins over
// `[features] apps = true` in config.toml and leaves local `mcp_servers` alone.
//
// There is deliberately no per-run allowlist: `-c apps.<id>.enabled` merges with
// the user's config.toml instead of replacing it, so an inherited
// `[apps.<id>] enabled = true` survives `apps._default.enabled = false`, and
// whether a single app works at all next to `features.apps=false` is unproven.
// Add one only together with a live tool-inventory proof.

/** Recorded in broker.json and answered on broker `initialize`; bump when the policy changes. */
export const APPS_POLICY_ID = "apps:deny-v1";

/** Global codex flag: must precede the subcommand, like the peers override. */
export const APPS_DISABLE_OVERRIDE = "features.apps=false";

const APP_SERVER_NAME = /codex_apps/;

/**
 * Whether a non-interactive client may auto-accept an MCP elicitation.
 *
 * Only a standard MCP `form` elicitation from a server that is not the ChatGPT
 * apps server is accepted, as before for local MCP servers. App consent
 * (`codex_apps`), OpenAI-specific forms (`openai/form`, `openaiForm`), URL
 * elicitations (sign-in/consent pages) and anything unrecognised are declined:
 * there is no human here to consent.
 * @param {unknown} params
 * @returns {boolean}
 */
export function shouldAutoAcceptElicitation(params) {
  if (!params || typeof params !== "object") {
    return false;
  }
  const { serverName, mode } = /** @type {{ serverName?: unknown, mode?: unknown }} */ (params);
  if (typeof serverName !== "string" || serverName.length === 0 || APP_SERVER_NAME.test(serverName)) {
    return false;
  }
  return mode === "form";
}
