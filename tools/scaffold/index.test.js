import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaffoldMarker } from './index.js';

test('scaffoldMarker returns the workspace marker', () => {
  assert.equal(scaffoldMarker(), 'logalot:scaffold');
});
