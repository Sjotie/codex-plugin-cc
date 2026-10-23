import { createHash } from "node:crypto";

// The macos-companion-* harnesses observe the generation transport (envelope
// wire v2): beginSessionAdmission, envelope.generation and envelope.source.
// Design D (#1916) replaced it with wire v3, whose native proof is
// tests/fenced-lock/macos-d-pty-probe.py. These harnesses stay as the record
// of the pre-D evidence and run only against a pre-D product, e.g.
// FENCED_LOCK_PRODUCT_REF=258047fbc24cfb8539897875410282c65ede842b for
// macos-companion-live.mjs.
export const PRE_D_PRODUCT_REF = "258047fbc24cfb8539897875410282c65ede842b";

// git rev-parse <PRE_D_PRODUCT_REF>:plugins/codex/scripts/lib/session-admission.mjs
export const PRE_D_SESSION_ADMISSION_BLOB = "4155409a29102697cd70263af006c106ca6a97a1";

// sessionAdmissionSource: the text of the product's session-admission.mjs.
export function requireWireV2(sessionAdmissionSource, harness) {
  // The actual pre-D module has a literal version: 2, no version constant.
  // Admit only that reviewed source's exact git blob; no syntax heuristics.
  const bytes = Buffer.from(sessionAdmissionSource, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blob === PRE_D_SESSION_ADMISSION_BLOB) return;
  process.stderr.write(`${harness}: this harness belongs to the generation transport (wire v2) and is out of service for this product version. ` +
    `Use tests/fenced-lock/macos-d-pty-probe.py for wire v3, or run this harness against the pre-D product ${PRE_D_PRODUCT_REF}.\n`);
  process.exit(2);
}
