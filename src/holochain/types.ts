/**
 * Holochain signing-credential and report types.
 */

/**
 * Encoded Holochain capability signing credentials (all fields base64).
 *
 * Produced once by `hcInit` (which authorizes signing on the cell) and persisted
 * so the periodic invoice job can sign zome calls without re-authorizing. NOTE:
 * Holochain regenerates these on every conductor restart (a lair keystore
 * session quirk) — so `hc:init` must be re-run after a Holochain restart.
 */
export interface EncCreds {
  /** The capability secret. */
  cap: string;
  /** The signing keypair public key. */
  pub: string;
  /** The signing keypair private key. */
  sec: string;
  /** The key type (ed25519). */
  typ: string;
  /** The public key formatted as a Holochain agent pub key. */
  sig: string;
}
