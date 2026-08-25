// The 2 GiB line, in the three places it bites.
//
// `node --test gecko.js/js`. Every case here is a real value from the crash that
// prompted the file: pointer 2358448128, which an Int32Array reports as
// -1936519168.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitsAligned, idx32, u32 } from './heapmath.ts';

const PTR = 2358448128;          // 2.35 GiB into the heap: a normal address
const AS_SIGNED = -1936519168;   // the same bits through an Int32Array
const FOUR_GIB = 4294967296;

test('the two numbers in the crash are the same address', () => {
  assert.equal(AS_SIGNED >>> 0, PTR);
});

test('an index above 2 GiB does not go negative', () => {
  // `(PTR + 20) >> 2` is negative — writes there go nowhere and reads come back
  // undefined, with no error anywhere.
  assert.ok(((PTR + 20) >> 2) < 0);
  assert.equal(idx32(PTR + 20), (PTR + 20) / 4);
  assert.ok(idx32(PTR + 20) > 0);
});

test('a pointer is read as the address it is, not as a negative', () => {
  const view = new Int32Array(4);
  view[2] = AS_SIGNED;
  assert.equal(view[2], AS_SIGNED, 'the raw read really is negative');
  assert.equal(u32(view, 8), PTR);
});

test('reading past the view is 0, not undefined', () => {
  // A lagging heap view is normal here; arithmetic on `undefined` would spread
  // NaN into a bounds check that then passes.
  assert.equal(u32(new Int32Array(2), 400), 0);
});

test('the bounds check cannot be defeated by the sign bit', () => {
  // THE bug: the old check was `ptr + len > byteLength`, and for a negative ptr
  // that is false — so a pointer 2.35 GiB in sailed through and
  // `new Uint32Array(buffer, -1936519168, n)` threw.
  assert.equal(AS_SIGNED + 8192 > FOUR_GIB, false, 'the old check passed this');
  assert.equal(fitsAligned(AS_SIGNED, 8192, 1 << 20), false);
});

test('accepts a real frame and rejects the shapes that crash', () => {
  assert.equal(fitsAligned(1024, 4096, 1 << 20), true);
  // Past the end: the shared heap grew under us and this view lags behind it.
  assert.equal(fitsAligned(1 << 20, 4096, 1 << 20), false);
  // Misaligned: a Uint32Array view would throw rather than draw.
  assert.equal(fitsAligned(1026, 4096, 1 << 20), false);
  // Nothing to draw is not an error — it is how the engine says "no popup".
  assert.equal(fitsAligned(0, 4096, 1 << 20), false);
  assert.equal(fitsAligned(1024, 0, 1 << 20), false);
});

test('a frame at the very top of a 4 GiB heap still fits', () => {
  // The sum is exact in a double, so the check does not wrap where it matters.
  assert.equal(fitsAligned(FOUR_GIB - 4096, 4096, FOUR_GIB), true);
  assert.equal(fitsAligned(FOUR_GIB - 4096, 8192, FOUR_GIB), false);
});
