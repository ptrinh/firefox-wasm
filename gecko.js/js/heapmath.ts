/**
 * Reading a wasm heap that can be bigger than 2 GiB.
 *
 * ══ THE BUG THIS EXISTS FOR ══
 *
 * Opening facebook.com killed the browser with
 *
 *   RangeError: Start offset -1936519168 is outside the bounds of the buffer
 *       at new Uint32Array … at drawPopupOverlay … at blit … at runCmd … at pump
 *
 * -1936519168 is not a bad pointer. It is 2358448128 — a perfectly good address
 * 2.35 GiB into the heap — read back through an `Int32Array`, where everything
 * from 2 GiB up is negative. The engine is linked with
 * `-sMAXIMUM_MEMORY=4294967296` (build-lib.sh), so a heavy page really does push
 * the heap past that line, and from then on every pointer this file used to read
 * came back negative.
 *
 * Two ways that then failed, and the second is the nastier:
 *
 *   1. `new Uint32Array(buffer, negative, n)` throws, which is the crash above.
 *
 *   2. The guard meant to catch a bad pointer — `resPtr + len > byteLength` —
 *      PASSES for a negative one, because a negative plus a length is still
 *      smaller than the buffer. The check that existed to prevent this could not
 *      see it.
 *
 * And a third, silent: `(ptr + offset) >> 2` converts its operand to Int32, so
 * for a pointer above 2 GiB the shift produces a NEGATIVE index. Writes at that
 * index go nowhere and reads come back `undefined` — no error anywhere, just an
 * engine that stops responding.
 *
 * So pointers are read unsigned, indices are computed with `>>>`, and the bounds
 * check is done in unsigned arithmetic where it cannot be defeated by the sign
 * bit. All three are trivial; being wrong about any of them is a page that
 * crashes only once the heap is big, which is to say only on the pages people
 * actually care about.
 */

/** A 32-bit index into a heap view, safe above 2 GiB. */
export function idx32(byteOffset: number): number {
  // `>>> 2`, not `>> 2`: the signed shift coerces to Int32 first, so a byte
  // offset above 2 GiB comes out negative.
  return (byteOffset >>> 0) / 4 >>> 0;
}

/** Read a pointer-or-length field as the unsigned 32-bit value it is. */
export function u32(view: Int32Array | Uint32Array, byteOffset: number): number {
  const v = view[idx32(byteOffset)];
  return v === undefined ? 0 : v >>> 0;
}

/**
 * Is `[ptr, ptr+len)` inside a buffer of `byteLength`, and 4-byte aligned?
 *
 * Unsigned throughout. Zero length is not "in bounds" but "nothing to draw", and
 * the callers treat it as a frame to skip rather than an error — the engine sends
 * an empty result whenever there is no popup open.
 */
export function fitsAligned(ptr: number, len: number, byteLength: number): boolean {
  const p = ptr >>> 0;
  const n = len >>> 0;
  if (p === 0 || n === 0) return false;
  if ((p & 3) !== 0) return false;
  // Both are < 2^32, so this sum is exact in a double and cannot wrap.
  return p + n <= byteLength;
}
