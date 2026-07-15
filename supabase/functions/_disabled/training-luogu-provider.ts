/**
 * DORMANT PROVIDER REFERENCE — DO NOT IMPORT OR DEPLOY.
 *
 * Luogu submission synchronization was disabled in phase 2 because there is
 * no approved public submission API and the public record pages disallow
 * automated access.  This file preserves only the provider contract and
 * difficulty mapping needed for a future, permission-backed implementation.
 * It intentionally contains no network request, credential, session, parser,
 * or executable synchronization path.
 */
export const LUOGU_PROVIDER_STATUS = "awaiting_official_permission" as const;

export const luoguDifficultyReference: Record<number, number> = {
  0: 800,
  1: 900,
  2: 1200,
  3: 1500,
  4: 1800,
  5: 2200,
  6: 2600,
  7: 3000,
};

export type DormantLuoguProvider = {
  enabled: false;
  restoreRequires: readonly string[];
};

export const dormantLuoguProvider: DormantLuoguProvider = {
  enabled: false,
  restoreRequires: [
    "written_permission_or_official_api",
    "documented_rate_and_retention_limits",
    "user_revocation_flow",
    "new_contract_and_security_review",
  ],
};
