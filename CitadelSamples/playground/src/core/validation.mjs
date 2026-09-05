/**
 * Input validation.
 *
 * One engine validates shared-profile fields and sample-specific fields alike,
 * because both are described by the same field descriptor. A field is required
 * outright, required conditionally (`requiredWhen`), derived from an earlier
 * recipe, a fixed sample default, or a secret.
 *
 * Validation is pure: it reads values, it never mutates them.
 */

import { ACKNOWLEDGED_RISK_LEVELS } from './types.mjs';
import { isWellFormedUnicode } from './identifiers.mjs';

/** @returns {boolean} true when a value counts as "not supplied". */
export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '' || value.trim() === 'REPLACE';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Evaluate a `requiredWhen` clause.
 *
 * Supported forms:
 *   { field: 'keyVault.useAccessContractKv', equals: true }
 *   { field: 'foundry.enableA2aAsset', equals: true }
 *   { field: 'x', in: ['a','b'] }
 *   { field: 'x', notBlank: true }
 *   { all: [clause, ...] } / { any: [clause, ...] }
 */
export function evaluateCondition(condition, read) {
  if (!condition) return true;
  if (Array.isArray(condition.all)) return condition.all.every((clause) => evaluateCondition(clause, read));
  if (Array.isArray(condition.any)) return condition.any.some((clause) => evaluateCondition(clause, read));
  const actual = read(condition.field);
  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) return actual === condition.equals;
  if (Array.isArray(condition.in)) return condition.in.includes(actual);
  if (condition.notBlank) return !isBlank(actual);
  if (condition.blank) return isBlank(actual);
  return true;
}

function describeCondition(condition) {
  if (!condition) return '';
  if (Array.isArray(condition.all)) return condition.all.map(describeCondition).join(' and ');
  if (Array.isArray(condition.any)) return condition.any.map(describeCondition).join(' or ');
  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    return `${condition.field} is ${JSON.stringify(condition.equals)}`;
  }
  if (Array.isArray(condition.in)) return `${condition.field} is one of ${condition.in.join(', ')}`;
  if (condition.notBlank) return `${condition.field} is set`;
  if (condition.blank) return `${condition.field} is empty`;
  return condition.field ?? '';
}

/** Coerce a raw form value into the field's declared type. */
export function coerceValue(field, raw) {
  if (raw === undefined) return undefined;
  switch (field.type) {
    case 'integer': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
      if (typeof raw === 'string') {
        if (raw.trim() === '') return undefined;
        const parsed = Number(raw.trim());
        return Number.isFinite(parsed) ? parsed : NaN;
      }
      return NaN;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return Boolean(raw);
    }
    case 'string-list': {
      if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
      if (typeof raw === 'string') {
        return raw
          .split(/[,\n]/)
          .map((item) => item.trim())
          .filter(Boolean);
      }
      return [];
    }
    default:
      return typeof raw === 'string' ? (field.preserveWhitespace ? raw : raw.trim()) : raw;
  }
}

function validateOne(field, value, path) {
  const issues = [];
  const push = (severity, message) => issues.push({ path, field: field.name, severity, message });

  if (typeof value === 'string' && !isWellFormedUnicode(value)) {
    push('error', `${field.label} must contain well-formed Unicode text.`);
    return issues;
  }
  if (typeof value === 'string' && value.includes('\0') && field.allowNul !== true) {
    push('error', `${field.label} cannot contain NUL bytes.`);
    return issues;
  }
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item === 'string' && !isWellFormedUnicode(item))) {
      push('error', `${field.label} must contain well-formed Unicode text.`);
      return issues;
    }
    if (value.some((item) => typeof item === 'string' && item.includes('\0'))) {
      push('error', `${field.label} cannot contain NUL bytes.`);
      return issues;
    }
  }

  if (field.type === 'integer') {
    if (Number.isNaN(value)) {
      push('error', `${field.label} must be a whole number.`);
      return issues;
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) push('error', `${field.label} must be a whole number.`);
      if (typeof field.min === 'number' && value < field.min) {
        push('error', `${field.label} must be at least ${field.min}.`);
      }
      if (typeof field.max === 'number' && value > field.max) {
        push('error', `${field.label} must be at most ${field.max}.`);
      }
    }
  }

  if (field.type === 'enum' && !isBlank(value)) {
    const allowed = (field.options ?? []).map((option) => option.value);
    if (!allowed.includes(value)) {
      push('error', `${field.label} must be one of: ${allowed.join(', ')}.`);
    }
  }

  if ((field.type === 'url' || field.type === 'string') && typeof value === 'string' && value !== '') {
    if (field.type === 'url' && !/^https:\/\/[^\s]+$/i.test(value)) {
      push('error', `${field.label} must be an https:// URL.`);
    }
    if (field.pattern) {
      const re = field.pattern instanceof RegExp ? field.pattern : new RegExp(field.pattern);
      if (!re.test(value)) {
        push('error', field.patternMessage ?? `${field.label} is not in the expected format.`);
      }
    }
    if (typeof field.maxLength === 'number' && value.length > field.maxLength) {
      push('error', `${field.label} must be ${field.maxLength} characters or fewer.`);
    }
  }

  if (field.type === 'secret' && typeof value === 'string' && value !== '' && /\s/.test(value)) {
    push('warning', `${field.label} contains whitespace. Gateway keys normally do not.`);
  }

  return issues;
}

/**
 * Validate a set of field descriptors against values.
 *
 * @param {Array} fields   field descriptors (see catalogue/profiles.mjs)
 * @param {(path: string) => unknown} read   resolves any dotted path, so a
 *        conditional clause can reference a field in another profile
 * @param {string} [prefix] dotted prefix for the field's own path
 */
export function validateFields(fields, read, prefix = '') {
  const issues = [];
  const missing = [];
  for (const field of fields ?? []) {
    // A decorated sample field already knows its own dotted path; a profile
    // field is addressed by prefix. Both resolve to the same string.
    const path = field.path ?? (prefix ? `${prefix}.${field.name}` : field.name);
    const value = coerceValue(field, read(path));
    const conditionallyRequired = field.requiredWhen ? evaluateCondition(field.requiredWhen, read) : false;
    const required = field.classification === 'required' || conditionallyRequired;

    if (isBlank(value)) {
      if (required) {
        missing.push(path);
        issues.push({
          path,
          field: field.name,
          severity: 'error',
          message: field.requiredWhen
            ? `${field.label} is required when ${describeCondition(field.requiredWhen)}.`
            : `${field.label} is required.`,
        });
      } else if (field.classification === 'derived' && field.warnWhenBlank !== false) {
        issues.push({
          path,
          field: field.name,
          severity: 'warning',
          message: `${field.label} is not known yet. ${field.derivedFrom ?? 'Run the recipe that produces it, or type it in.'}`,
        });
      }
      continue;
    }

    issues.push(...validateOne(field, value, path));
  }
  return { issues, missing };
}

export function hasErrors(issues) {
  return (issues ?? []).some((issue) => issue.severity === 'error');
}

export function errorsOf(issues) {
  return (issues ?? []).filter((issue) => issue.severity === 'error');
}

export function warningsOf(issues) {
  return (issues ?? []).filter((issue) => issue.severity === 'warning');
}

/**
 * Guard a risky recipe. A `state-changing`, `load-generating`, `destructive`,
 * or explicitly acknowledgement-required recipe must carry fresh consent for
 * THIS run before an executor is allowed to see it.
 */
export function acknowledgementRequired(sample, { read = () => undefined } = {}) {
  if (sample?.risk?.acknowledgementWhen) {
    return evaluateCondition(sample.risk.acknowledgementWhen, read);
  }
  return (
    ACKNOWLEDGED_RISK_LEVELS.includes(sample?.risk?.level)
    || sample?.risk?.requiresAcknowledgement === true
  );
}

export function checkAcknowledgement(sample, { acknowledged = false, read } = {}) {
  const required = acknowledgementRequired(sample, { read });
  if (!required) return { required: false, satisfied: true, issues: [] };
  if (acknowledged) return { required: true, satisfied: true, issues: [] };
  return {
    required: true,
    satisfied: false,
    issues: [
      {
        path: `${sample.id}.acknowledgement`,
        field: 'acknowledgement',
        severity: 'error',
        message:
          sample.risk?.acknowledgementPrompt ??
          'This recipe changes, loads or deletes real resources. Acknowledge the effect before running it.',
      },
    ],
  };
}
