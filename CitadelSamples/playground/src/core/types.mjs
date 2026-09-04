/**
 * Shared vocabulary for the playground.
 *
 * Every constant in this file is a contract: the catalogue, the builders, the
 * executor boundary, the view models and the tests all agree on these strings.
 * Nothing here performs I/O, so this module is safe in both Node and browser.
 */

/** Groups shown in the recipe directory, in operating order. */
export const GROUPS = Object.freeze([
  Object.freeze({
    id: 'discover',
    title: 'Discover',
    summary: 'Confirm which subscription and which gateway the run will touch.',
  }),
  Object.freeze({
    id: 'prepare',
    title: 'Prepare',
    summary: 'Make the Foundry agent, the APIM identity and the source API ready to publish.',
  }),
  Object.freeze({
    id: 'publish-grant',
    title: 'Publish and grant',
    summary: 'Deploy the publish contract, the mixed access contract and verify the minted secrets.',
  }),
  Object.freeze({
    id: 'exercise',
    title: 'Exercise',
    summary: 'Call the published tools and agent through the gateway the way a consumer would.',
  }),
  Object.freeze({
    id: 'observe',
    title: 'Observe',
    summary: 'Check that usage telemetry and backend resiliency landed.',
  }),
  Object.freeze({
    id: 'policy',
    title: 'Policy',
    summary: 'Prove the access-contract policy branched per asset type by tripping its limits.',
  }),
  Object.freeze({
    id: 'lifecycle',
    title: 'Lifecycle',
    summary: 'Remove what the run created, and name what the notebook leaves behind.',
  }),
]);

export const GROUP_IDS = Object.freeze(GROUPS.map((group) => group.id));

/**
 * How a field is sourced. This is the classification the product brief asks
 * for, and the form, the validator and the guides all read it.
 *
 *  required          the user must supply it before a plan can be generated
 *  conditional       required only when another field takes a given value
 *  derived           produced by an earlier recipe or by a helper, not typed
 *  sample-default    fixed value the notebook hard-codes; editable, pre-filled
 *  secret            memory-only; never persisted, previewed or copied
 */
export const FIELD_CLASSIFICATIONS = Object.freeze([
  'required',
  'conditional',
  'derived',
  'sample-default',
  'secret',
]);

/**
 * How a field is *needed by one sample*, which is a different question from
 * where its value comes from.
 *
 * `FIELD_CLASSIFICATION` answers "where did this value come from?".
 * `REQUIREMENT_LEVEL` answers "must I supply it before THIS sample can run?".
 *
 * A field can be `derived` (classification) and still `mandatory` for a given
 * recipe — the gateway URL is produced by discovery, but the Weather handshake
 * cannot execute without it. Conversely `keyVault.subscriptionId` is a
 * `sample-default` that stays `optional` everywhere.
 *
 *  mandatory    a blank value blocks execution of this sample
 *  conditional  mandatory only while the stated condition holds
 *  optional     a declared default or documented fallback covers a blank
 *  generated    produced by another recipe or by this run; typeable override
 *  secret       a credential; `blocking` says whether this sample needs it
 */
export const REQUIREMENT_LEVELS = Object.freeze([
  'mandatory',
  'conditional',
  'optional',
  'generated',
  'secret',
]);

/** Display order of the requirement groups in the Configure view. */
export const REQUIREMENT_GROUPS = Object.freeze([
  Object.freeze({
    id: 'mandatory',
    title: 'Mandatory',
    summary: 'This sample cannot execute until every one of these carries a value.',
  }),
  Object.freeze({
    id: 'conditional',
    title: 'Conditional',
    summary: 'Required only while the stated condition holds. Each entry names its exact condition.',
  }),
  Object.freeze({
    id: 'optional',
    title: 'Optional (defaults)',
    summary: 'Pre-filled from the notebook. A blank falls back to the documented default and never blocks a run.',
  }),
  Object.freeze({
    id: 'generated',
    title: 'Generated / override',
    summary: 'Produced by an earlier recipe or by this run. Type a value only to override what was discovered.',
  }),
  Object.freeze({
    id: 'secret',
    title: 'Secrets',
    summary: 'Held in memory for this browser tab only. Exported as an environment placeholder, never as a value.',
  }),
]);

/** Default requirement implied by a classification when a sample says nothing. */
export const CLASSIFICATION_REQUIREMENT = Object.freeze({
  required: 'mandatory',
  conditional: 'conditional',
  derived: 'generated',
  'sample-default': 'optional',
  secret: 'secret',
});

/** Executables the local executor may ever spawn. Nothing else is allowed. */
export const ALLOWED_EXECUTABLES = Object.freeze(['az', 'python']);

/** Runtime dependencies a sample can declare, used for per-sample capability. */
export const RUNTIME_DEPENDENCIES = Object.freeze([
  'azure-cli', // the `az` executable, signed in
  'python', // a Python interpreter plus the declared importable modules
  'accelerator', // the vendored Bicep/policy/weather bundle
  'gateway-network', // outbound HTTPS to the configured gateway
  'foundry-network', // outbound HTTPS to the Foundry data plane
]);

/** Input control types the configure view knows how to render. */
export const FIELD_TYPES = Object.freeze([
  'string',
  'multiline',
  'integer',
  'boolean',
  'enum',
  'string-list',
  'secret',
  'url',
]);

/** Typed execution-step kinds. An executor declares which of these it supports. */
export const STEP_TYPES = Object.freeze([
  'artifact', // generates a file the user would commit (bicepparam, policy xml)
  'azure-cli', // an `az ...` management-plane invocation
  'http', // a data-plane HTTP request through the gateway or Foundry
  'library', // requires a Python/SDK runtime the browser does not have
  'assertion', // evaluates captured step output; no side effect
]);

/** Result states an executor may report. `completed` never means "passed". */
export const EXECUTION_STATES = Object.freeze([
  'not-run',
  'generated',
  'blocked',
  'running',
  'completed',
  'failed',
  'cancelled',
  'inconclusive',
]);

/** Risk levels. `none` still renders a risk note; it never renders nothing. */
export const RISK_LEVELS = Object.freeze(['read-only', 'state-changing', 'load-generating', 'destructive']);

/** Risk levels that must not run without a fresh, explicit acknowledgement. */
export const ACKNOWLEDGED_RISK_LEVELS = Object.freeze(['state-changing', 'load-generating', 'destructive']);

/** Canonical asset definitions the notebook publishes (cell 14). */
export const ASSET_TYPES = Object.freeze(['mcp-from-api', 'mcp-existing', 'a2a']);

/**
 * Asset-type path prefixes applied when `useAssetTypePathPrefix = true`
 * (the publish contract default, cell 14 / cell 20).
 */
export const ASSET_TYPE_PREFIX = Object.freeze({
  'mcp-from-api': 'mcp',
  'mcp-existing': 'mcp',
  a2a: 'agent',
});

/** MCP protocol revision the notebook pins in `initialize` (cells 20, 29, 31). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Header APIM returns and the client must echo on every follow-up MCP call. */
export const MCP_SESSION_HEADER = 'Mcp-Session-Id';

/** `Accept` the notebook sends so APIM may answer with JSON or SSE. */
export const MCP_ACCEPT = 'application/json, text/event-stream';

/** The upstream notebook, recorded once and asserted by the provenance test. */
export const SOURCE_NOTEBOOK = Object.freeze({
  fileName: 'citadel-publish-contract-tests.ipynb',
  sha256: 'ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb',
  cellCount: 36,
  markdownCellCount: 17,
  codeCellCount: 19,
  /** 0-based indices of the 19 code cells, in notebook order. */
  codeCellIndexes: Object.freeze([2, 4, 6, 8, 10, 12, 14, 15, 17, 18, 20, 22, 24, 26, 28, 29, 31, 33, 35]),
});

/**
 * Code cells that deliberately do not become a selectable recipe, with the
 * reason. The catalogue-coverage test uses this so an un-mapped cell is a test
 * failure rather than a silent omission.
 */
export const NON_RECIPE_CODE_CELLS = Object.freeze([
  Object.freeze({
    cell: 2,
    reason:
      'Notebook variable initialisation. Modelled as the five shared profiles instead of a runnable recipe, because it only assigns configuration.',
  }),
  Object.freeze({
    cell: 33,
    reason:
      'Results summary. It prints the notebook`s own `results` dict, which is populated inconsistently across cells, so the playground reports each recipe`s assertions directly instead of reproducing an incomplete roll-up.',
  }),
]);

/** Sample count asserted by the catalogue test; the brief fixes it at 19. */
export const EXPECTED_SAMPLE_COUNT = 19;

export function isRiskAcknowledgementRequired(riskLevel) {
  return ACKNOWLEDGED_RISK_LEVELS.includes(riskLevel);
}

/** Root of the vendored accelerator bundle, relative to `playground/`. */
export const ACCELERATOR_ROOT = 'runtime/accelerator';

/** Per-run workspace root, relative to `playground/`. Git-ignored. */
export const RUN_WORKSPACE_ROOT = '.runs';

/** Wire version of the local execution request. Bumped on a breaking change. */
export const EXECUTION_PROTOCOL_VERSION = 2;

