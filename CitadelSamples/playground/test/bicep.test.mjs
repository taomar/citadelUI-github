import test from 'node:test';
import assert from 'node:assert/strict';

import { bicepValue } from '../src/core/bicep.mjs';

test('Bicep strings preserve apostrophes, newlines, interpolation text, slashes and controls', () => {
  const value = "O'Brien\nliteral ${notInterpolation}\\path\tbell:\u0007 snowman:\u2603";
  const expected = "'O\\'Brien\\nliteral \\${notInterpolation}\\\\path\\tbell:\\u{7} snowman:\u2603'";
  assert.equal(bicepValue(value), expected);
  assert.equal(bicepValue(value), expected, 'serialization must be deterministic');
  assert.throws(() => bicepValue('\ud800'), /well-formed Unicode/);
});
