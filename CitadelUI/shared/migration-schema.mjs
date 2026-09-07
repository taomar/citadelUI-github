import { extractSchema } from './citadel-core.mjs';
import {
  literalBicep, MigrationError, MIGRATION_LIMITS, parameterName, safeLabel,
  scanBicep, sensitiveName, sensitiveValue,
} from './migration-input.mjs';

const PRIMITIVES = new Set(['string', 'int', 'bool', 'array', 'object']);
const DECLARATIONS = new Set([
  'param', 'type', 'var', 'resource', 'module', 'output', 'targetScope', 'import',
  'metadata', 'extension', 'func', 'assert',
]);
const DECORATORS = new Set(['secure', 'description', 'metadata', 'allowed', 'minLength', 'maxLength', 'minValue', 'maxValue']);

/**
 * Refine the editor's extracted guidance with a bounded schema proof.
 * `extractSchema` alone cannot distinguish `string` from `string[]`, a union,
 * a user-defined nested type, or a decorator whose value is an expression.
 * Those remain unknown, never an enabled "compatible" replacement.
 */
export function readMigrationSchema(text) {
  if (text === null || text === undefined) return { definitions: [], complete: false };
  try {
    const tokens = scanBicep(text);
    const guidance = extractSchema(text);
    const starts = tokens.map((token, index) => ({ ...token, index }))
      .filter((token) => token.first && token.depth === 0 && (token.text === '@' || DECLARATIONS.has(token.text)));
    const definitions = [];
    let decorators = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      const next = starts[index + 1];
      const body = tokens.slice(start.index, next?.index ?? tokens.length);
      if (start.text === '@') {
        const name = body[1]?.text;
        const wellFormed = body[1]?.kind === 'word' && body[2]?.text === '(' && body.at(-1)?.text === ')';
        decorators.push({
          name,
          wellFormed,
          secure: body.some((token) => token.text.toLowerCase() === 'secure'),
          value: wellFormed ? literalBicep(text.slice(body[2].end, body.at(-1).start)) : { status: 'unsupported' },
        });
        continue;
      }
      if (start.text !== 'param') { decorators = []; continue; }
      const name = parameterName(body[1]?.text || '');
      const equals = body.findIndex((token, tokenIndex) => tokenIndex > 1 && token.depth === 0 && token.text === '=');
      const typeTokens = body.slice(2, equals < 0 ? body.length : equals);
      const type = typeTokens.map((token) => token.text).join('');
      const base = Object.hasOwn(guidance, name) ? guidance[name] : {};
      const definition = {
        name,
        type,
        known: PRIMITIVES.has(type) && typeTokens.length === 1,
        secure: decorators.some((decorator) => decorator.secure) || sensitiveName(name),
        required: equals < 0,
        hasDefault: equals >= 0,
        default: equals < 0 || !body[equals + 1]
          ? { status: 'absent' }
          : literalBicep(text.slice(body[equals + 1].start, body.at(-1).end)),
        description: safeLabel(base.description || '', ''),
        allowedValues: null,
        review: ['array', 'object'].includes(type) ? 'outer-type-only' : 'semantic-review',
      };
      const seen = new Set();
      for (const decorator of decorators) {
        if (!decorator.wellFormed || !DECORATORS.has(decorator.name) || seen.has(decorator.name)) definition.known = false;
        seen.add(decorator.name);
        const literal = decorator.value;
        if (decorator.name === 'secure') continue;
        if (decorator.name === 'metadata') {
          // Prose/custom metadata does not prove a nested schema.
          definition.review = 'semantic-review';
          continue;
        }
        if (decorator.name === 'description') {
          if (literal.status === 'literal' && typeof literal.value === 'string') {
            definition.description = safeLabel(literal.value.replace(/\s+/g, ' '), '');
          }
          continue;
        }
        if (decorator.name === 'allowed') {
          if (literal.status !== 'literal' || !Array.isArray(literal.value) ||
              !['string', 'int', 'bool'].includes(type) ||
              literal.value.some((value) => !typeMatches(value, type))) {
            definition.known = false;
          } else definition.allowedValues = literal.value;
          continue;
        }
        if (['minLength', 'maxLength', 'minValue', 'maxValue'].includes(decorator.name)) {
          const numeric = literal.status === 'literal' && Number.isSafeInteger(literal.value);
          const applicable = decorator.name.endsWith('Length') ? ['string', 'array'].includes(type) : type === 'int';
          if (!numeric || !applicable || (decorator.name.endsWith('Length') && literal.value < 0)) {
            definition.known = false;
          } else definition[decorator.name] = literal.value;
        }
      }
      if (definition.minLength > definition.maxLength || definition.minValue > definition.maxValue) definition.known = false;
      if (sensitiveValue(definition.default.value, name)) definition.secure = true;
      definitions.push(definition);
      decorators = [];
      if (definitions.length > MIGRATION_LIMITS.parameters) throw new MigrationError('limit');
    }
    const counts = new Map();
    for (const definition of definitions) {
      const key = definition.name.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const definition of definitions) {
      definition.duplicate = counts.get(definition.name.toLowerCase()) > 1;
      if (definition.duplicate) definition.known = false;
    }
    return { definitions, complete: definitions.length > 0 };
  } catch (error) {
    if (error instanceof MigrationError && error.code === 'limit') throw error;
    return { definitions: [], complete: false };
  }
}

export function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'int') return Number.isSafeInteger(value);
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return false;
}

/** Messages contain constraints, never the rejected value. */
export function checkMigrationValue(value, definition) {
  if (!definition?.known) return ['The current schema is unknown or unsupported.'];
  if (!typeMatches(value, definition.type)) return [`Requires a literal ${definition.type}; no coercion is performed.`];
  const problems = [];
  if (definition.allowedValues && !definition.allowedValues.some((allowed) => Object.is(allowed, value))) {
    problems.push('The value is outside the current @allowed values.');
  }
  const size = typeof value === 'string' || Array.isArray(value) ? value.length : null;
  if (size !== null && definition.minLength !== undefined && size < definition.minLength) {
    problems.push(`Requires a length of at least ${definition.minLength}.`);
  }
  if (size !== null && definition.maxLength !== undefined && size > definition.maxLength) {
    problems.push(`Requires a length of at most ${definition.maxLength}.`);
  }
  if (typeof value === 'number' && definition.minValue !== undefined && value < definition.minValue) {
    problems.push(`Requires a value of at least ${definition.minValue}.`);
  }
  if (typeof value === 'number' && definition.maxValue !== undefined && value > definition.maxValue) {
    problems.push(`Requires a value of at most ${definition.maxValue}.`);
  }
  return problems;
}

export function placeholderValue(value) {
  return typeof value === 'string' && (
    !value.trim() ||
    /<[^>]+>|(?:^|[-_\s])(?:YOUR|REPLACE|CHANGEME)(?:$|[-_\s])/i.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  );
}

export function schemaGuidance(definition) {
  if (!definition) return { known: false, description: 'No current schema definition was found.' };
  const secure = definition.secure;
  return {
    known: definition.known,
    type: /^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.type) ? safeLabel(definition.type) : 'unsupported type expression',
    required: definition.required,
    secure,
    description: secure ? 'Sensitive field: configure a safe environment or Key Vault reference outside migration.' : definition.description,
    allowedValues: !definition.known || secure || sensitiveValue(definition.allowedValues) ? null : definition.allowedValues?.slice() || null,
    minLength: definition.minLength,
    maxLength: definition.maxLength,
    minValue: definition.minValue,
    maxValue: definition.maxValue,
    validation: ['array', 'object'].includes(definition.type)
      ? 'Outer type and supported decorators only; nested semantics need manual review.'
      : 'Supported type/decorators only; same names do not prove equivalent feature semantics.',
    defaultStatus: definition.default.status,
  };
}
