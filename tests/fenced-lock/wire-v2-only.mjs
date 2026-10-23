// The macos-companion-* harnesses observe the generation transport (envelope
// wire v2): beginSessionAdmission, envelope.generation and envelope.source.
// Design D (#1916) replaced it with wire v3, whose native proof is
// tests/fenced-lock/macos-d-pty-probe.py. These harnesses stay as the record
// of the pre-D evidence and run only against a pre-D product, e.g.
// FENCED_LOCK_PRODUCT_REF=258047fbc24cfb8539897875410282c65ede842b for
// macos-companion-live.mjs.
export const PRE_D_PRODUCT_REF = "258047fbc24cfb8539897875410282c65ede842b";

// sessionAdmissionSource: the text of the product's session-admission.mjs.
export function requireWireV2(sessionAdmissionSource, harness) {
  // This is a compatibility guard for known source, not a JS parser. Only
  // one explicit v2 declaration is supported; unknown formats stay retired.
  const declarations = [...sessionAdmissionSource.matchAll(/^export const ENVELOPE_VERSION\s*=\s*(\d+);\s*$/gm)];
  if (declarations.length === 1 && declarations[0][1] === "2") return;
  process.stderr.write(`${harness}: this harness belongs to the generation transport (wire v2) and is out of service for this product version. ` +
    `Use tests/fenced-lock/macos-d-pty-probe.py for wire v3, or run this harness against the pre-D product ${PRE_D_PRODUCT_REF}.\n`);
  process.exit(2);
}
