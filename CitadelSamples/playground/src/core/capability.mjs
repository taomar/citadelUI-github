/**
 * Per-sample runtime capability.
 *
 * "Can this playground run this sample right now?" is not one answer for all
 * nineteen recipes. Six need only outbound HTTPS; seven need the Azure CLI; two
 * need Python packages that are not installed for you; three need the vendored
 * template bundle. Reporting one global "execution attached" badge would hide
 * exactly the thing an operator needs to know before pressing Run.
 *
 * This module is pure so both the server and the browser can evaluate it from
 * the same probe results.
 */

/** Human labels for each declared dependency. */
export const DEPENDENCY_LABELS = Object.freeze({
  'azure-cli': 'Azure CLI (`az`), signed in',
  python: 'Python interpreter with the declared modules',
  accelerator: 'Vendored Bicep/policy bundle',
  'gateway-network': 'Outbound HTTPS to the gateway',
  'foundry-network': 'Outbound HTTPS to the Foundry data plane',
});

export const CAPABILITY_STATES = Object.freeze(['preview-only', 'ready', 'partial']);

/**
 * @param {object} sample
 * @param {object} probe   { mode, azureCli, python, accelerator, network }
 * @returns {{ state, ready, reasons, dependencies }}
 */
export function describeSampleCapability(sample, probe = {}) {
  const dependencies = (sample.runtime?.dependencies ?? []).map((id) => {
    const optional = id === 'python' && Boolean(sample.runtime?.python?.optionalReason);
    return {
      id,
      label: DEPENDENCY_LABELS[id] ?? id,
      optional,
      optionalReason: optional ? sample.runtime.python.optionalReason : '',
      ...evaluateDependency(id, sample, probe),
    };
  });

  if (probe.mode !== 'execute') {
    return Object.freeze({
      state: 'preview-only',
      ready: false,
      reasons: [
        'This server was started in preview mode. Plans are generated and inspected; nothing is executed. Start it with `npm run start:execute` to attach the local executor.',
      ],
      advisories: [],
      dependencies: Object.freeze(dependencies),
    });
  }

  const missing = dependencies.filter((dependency) => dependency.available === false && !dependency.optional);
  const optionalMissing = dependencies.filter((dependency) => dependency.available === false && dependency.optional);
  const advisories = optionalMissing.map(
    (dependency) =>
      `${dependency.label} is unavailable but optional for the primary path. ${dependency.optionalReason} If that fallback is needed, the run will stop and show the install command.`,
  );
  if (missing.length === 0) {
    return Object.freeze({
      state: 'ready',
      ready: true,
      reasons: [],
      advisories: Object.freeze(advisories),
      dependencies: Object.freeze(dependencies),
    });
  }
  return Object.freeze({
    state: 'partial',
    ready: false,
    reasons: missing.map((dependency) => dependency.reason),
    advisories: Object.freeze(advisories),
    dependencies: Object.freeze(dependencies),
  });
}

function evaluateDependency(id, sample, probe) {
  switch (id) {
    case 'azure-cli':
      if (probe.azureCli?.available === true) {
        return { available: true, detail: probe.azureCli.version ?? 'available' };
      }
      return {
        available: probe.azureCli === undefined ? null : false,
        reason:
          probe.azureCli?.reason ??
          'The Azure CLI was not found on PATH. Install it and run `az login`, then restart the playground.',
      };
    case 'python': {
      const required = sample.runtime?.python?.modules ?? [];
      if (probe.python?.available !== true) {
        return {
          available: probe.python === undefined ? null : false,
          reason:
            probe.python?.reason ??
            'No Python interpreter was found. Install Python 3.10 or newer; nothing is installed for you.',
        };
      }
      const missingModules = required.filter((module) => (probe.python.modules ?? {})[module] === false);
      if (missingModules.length > 0) {
        return {
          available: false,
          reason: `Python is present but ${missingModules.join(', ')} cannot be imported. Run \`python -m pip install -r runtime/requirements.txt\` yourself, then re-probe.`,
          missingModules,
        };
      }
      return { available: true, detail: probe.python.version ?? 'available' };
    }
    case 'accelerator':
      return probe.accelerator?.available === true
        ? { available: true, detail: `${probe.accelerator.files ?? 0} vendored file(s)` }
        : {
            available: probe.accelerator === undefined ? null : false,
            reason:
              probe.accelerator?.reason ??
              'The vendored template bundle under `runtime/accelerator` is missing, so nothing can be deployed from inside CitadelSamples.',
          };
    case 'gateway-network':
    case 'foundry-network':
      // Not probed: reaching a customer endpoint to check reachability would
      // itself be a call this playground has no consent to make.
      return {
        available: true,
        detail: 'Not probed. A network failure is reported by the step that makes the call.',
      };
    default:
      return { available: null, reason: `Unknown dependency "${id}".` };
  }
}

/** Roll the 19 per-sample answers up for the masthead. */
export function summariseCapability(samples, probe) {
  const perSample = samples.map((sample) => ({ id: sample.id, ...describeSampleCapability(sample, probe) }));
  const ready = perSample.filter((entry) => entry.ready).length;
  if (probe.mode !== 'execute') {
    return {
      mode: 'preview',
      label: 'Preview only',
      tone: 'neutral',
      ready: 0,
      total: perSample.length,
      detail: 'Plans are generated and inspected. Nothing is executed and nothing is sent anywhere.',
      perSample,
    };
  }

  if (ready === perSample.length) {
    return {
      mode: 'execute',
      label: 'Local execution ready',
      tone: 'success',
      ready,
      total: perSample.length,
      detail: 'Every sample`s declared runtime is present. Risk gates still apply.',
      perSample,
    };
  }

  return {
    mode: 'execute',
    label: `Partially ready — ${ready}/${perSample.length}`,
    tone: 'warning',
    ready,
    total: perSample.length,
    detail: 'Some samples are missing a declared runtime. Each one says exactly what it needs.',
    perSample,
  };
}

/**
 * Reconstruct the safe runtime-probe shape from the server's per-sample
 * capability answer. Module availability is merged across samples rather than
 * letting the first Python-backed recipe hide missing modules in a later one.
 */
export function probeFromCapabilityPayload(payload, sampleById) {
  const probe = {};
  for (const entry of payload.capability?.perSample ?? []) {
    const sample = sampleById?.get?.(entry.id);
    for (const dependency of entry.dependencies ?? []) {
      if (dependency.id === 'azure-cli' && probe.azureCli === undefined) {
        probe.azureCli = dependency.available
          ? { available: true, version: dependency.detail }
          : { available: false, reason: dependency.reason };
      }
      if (dependency.id === 'accelerator' && probe.accelerator === undefined) {
        probe.accelerator = dependency.available
          ? { available: true }
          : { available: false, reason: dependency.reason };
      }
      if (dependency.id !== 'python') continue;

      const modules = { ...(probe.python?.modules ?? {}) };
      const requiredModules = sample?.runtime?.python?.modules ?? [];
      if (dependency.available === true) {
        for (const module of requiredModules) modules[module] = true;
        probe.python = {
          available: true,
          version: dependency.detail ?? probe.python?.version,
          modules,
        };
      } else if (Array.isArray(dependency.missingModules)) {
        for (const module of requiredModules) {
          if (!dependency.missingModules.includes(module) && modules[module] === undefined) modules[module] = true;
        }
        for (const module of dependency.missingModules) modules[module] = false;
        probe.python = {
          available: true,
          version: probe.python?.version,
          reason: dependency.reason,
          modules,
        };
      } else if (probe.python?.available !== true) {
        probe.python = { available: false, reason: dependency.reason, modules };
      }
    }
  }
  return probe;
}
