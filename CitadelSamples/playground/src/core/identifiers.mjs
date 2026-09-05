/**
 * Turn human-readable contract labels into bounded path/resource identifiers.
 *
 * The pinned access-contract template concatenates three fields into product,
 * deployment and Foundry connection names. Its strictest composed limit leaves
 * 19 characters for those fields, so the first two keep short readable hints
 * and the third carries a digest of the exact three-label tuple. Slug collisions
 * therefore remain distinct without allowing punctuation, Unicode, traversal
 * text, or CLI-looking input to become syntax.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

export function isWellFormedUnicode(value) {
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stableDigest(value) {
  let hash = FNV_OFFSET_64;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }
  return hash.toString(36).padStart(13, '0');
}

function normalizedLabel(label) {
  const text = String(label ?? '').trim();
  if (text === '') throw new TypeError('Identifier labels must not be blank.');
  if (!isWellFormedUnicode(text)) {
    throw new TypeError('Identifier labels must contain well-formed Unicode.');
  }
  const normalized = text.normalize('NFC');
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new TypeError('Identifier labels must not contain control characters.');
  }
  return normalized;
}

function slugHint(label, maximum) {
  const slug = label
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'x').slice(0, maximum).replace(/-+$/g, '') || 'x';
}

export function contractIdentifierSegments({ businessUnit, useCaseName, environment }) {
  const labels = [
    normalizedLabel(businessUnit),
    normalizedLabel(useCaseName),
    normalizedLabel(environment),
  ];
  const digest = stableDigest(JSON.stringify(labels));
  return Object.freeze({
    businessUnitId: slugHint(labels[0], 2),
    useCaseId: slugHint(labels[1], 2),
    environmentId: `${slugHint(labels[2], 1)}-${digest}`,
  });
}
