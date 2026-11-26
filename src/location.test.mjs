// Smoke tests for the pure location helpers behind src/useLocation.js.
// Run with the node test runner: node --test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationKey, splitLocation, isSameLocation } from './location.js';

const HERE = 'https://yt2txt.willbright.link/share?url=A';

test('locationKey includes the query string', () => {
  assert.equal(locationKey({ pathname: '/share', search: '?url=A' }), '/share?url=A');
  assert.equal(locationKey({ pathname: '/', search: '' }), '/');
});

test('splitLocation inverts locationKey', () => {
  for (const key of ['/', '/history', '/share?url=A', '/share?url=a%3Fb&text=c']) {
    assert.equal(locationKey(splitLocation(key)), key);
  }
  assert.deepEqual(splitLocation('/share?url=A'), { pathname: '/share', search: '?url=A' });
  assert.deepEqual(splitLocation('/people'), { pathname: '/people', search: '' });
});

test('isSameLocation: a different query string is a different location', () => {
  assert.equal(isSameLocation('/share?url=B', HERE), false);
  assert.equal(isSameLocation('/share', HERE), false);
});

test('isSameLocation: the identical path + query is the same location', () => {
  assert.equal(isSameLocation('/share?url=A', HERE), true);
  assert.equal(isSameLocation('/share?url=A#top', HERE), true);
  assert.equal(isSameLocation('https://yt2txt.willbright.link/share?url=A', HERE), true);
});

test('isSameLocation: different paths and origins differ', () => {
  assert.equal(isSameLocation('/history', HERE), false);
  assert.equal(isSameLocation('https://example.com/share?url=A', HERE), false);
  assert.equal(isSameLocation('/', 'https://yt2txt.willbright.link/'), true);
});
