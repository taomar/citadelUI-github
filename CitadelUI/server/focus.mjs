/**
 * The three areas the UI is built around.
 *
 * The repository holds 17 parameter files across 12 deployment units, but only
 * three are edited as part of normal operation. Everything else stays reachable
 * through the full deployment list; these three get purpose-built screens.
 *
 * Each area names the file it edits. Presentation is *not* declared here -- the
 * section layout, prose and requirement badges are derived at request time from
 * the banner comments the files already carry (see doclayer.mjs). Hardcoding
 * groups here would duplicate knowledge that already exists in the repo and
 * would drift the moment upstream edits a banner.
 */

export const FOCUS_AREAS = [
  {
    id: 'main',
    kind: 'param',
    title: 'Azure Deployment',
    subtitle: 'Core infrastructure parameters for the hub deployment',
    path: 'bicep/infra/main.bicepparam',
    // Most values here read from the environment rather than being literals,
    // so the screen has to offer the .env layer alongside the file itself.
    envDriven: true,
    blurb:
      'Names, networking, feature flags and SKUs for the AI Hub Gateway itself. ' +
      'Most values resolve from environment variables at deployment time, so edits ' +
      'usually belong in the environment layer rather than in the file.',
  },
  {
    id: 'llm-onboarding',
    kind: 'param',
    title: 'LLM Onboarding',
    subtitle: 'Register model backends behind the gateway',
    path: 'bicep/infra/llm-backend-onboarding/main.bicepparam',
    envDriven: false,
    blurb:
      'Adds AI Foundry, Azure OpenAI and OpenAI-compatible backends to APIM, with ' +
      'circuit breaking, session affinity and model aliases. The backend array ships ' +
      'with commented-out examples for each provider type.',
  },
  {
    id: 'access-contracts',
    kind: 'contracts',
    title: 'Access Contracts',
    subtitle: 'Per-use-case products, subscriptions and policies',
    envDriven: false,
    blurb:
      'Each contract is a folder holding a parameter file and its APIM product ' +
      'policy. New contracts are created from the module template and its default ' +
      'policy, then edited independently.',
  },
];

export function findFocusArea(id) {
  return FOCUS_AREAS.find((a) => a.id === id) || null;
}
