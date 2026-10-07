import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebounce, createThrottle } from "../src/core.js";

/**
 * A fake scheduler + clock. Lets tests advance time and fire scheduled
 * callbacks synchronously, so assertions never depend on real elapsed time.
 *
 * Note on the two "time" concepts: `nowMs` is what the debounced function
 * reads via `clock()`; `queue` holds callbacks with an absolute `fireAt`.
 * We keep them in the same object so a single `advance(ms)` call moves both.
 */
function makeFakeTimer() {
  let nowMs = 0;
  // Monotonically increasing ids so clearInterval can match a real one.
  let nextId = 1;
  const queue = new Map(); // id -> { cb, fireAt }

  const clock = () => nowMs;

  function setTimeoutFn(cb, ms) {
    const id = nextId++;
    queue.set(id, { cb, fireAt: nowMs + ms });
    return id;
  }

  function clearTimeoutFn(id) {
    queue.delete(id);
  }

  /** Advance `ms` milliseconds, firing any due callbacks in order. */
  function advance(ms) {
    const target = nowMs + ms;
    // Drain callbacks whose fireAt <= target, earliest first.
    while (true) {
      let earliestId = null;
      let earliestFire = Infinity;
      for (const [id, entry] of queue) {
        if (entry.fireAt < earliestFire) {
          earliestFire = entry.fireAt;
          earliestId = id;
        }
      }
      if (earliestId === null || earliestFire > target) break;
      const entry = queue.get(earliestId);
      queue.delete(earliestId);
      // Move the clock to the callback's scheduled time so any nested
      // scheduling is relative to the right "now".
      nowMs = entry.fireAt;
      entry.cb();
    }
    nowMs = target;
  }

  /** @returns {number} count of pending timers. */
  function pending() {
    return queue.size;
  }

  return { clock, setTimeoutFn, clearTimeoutFn, advance, pending };
}

test("leading+trailing default: fires immediately then after quiet", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a");
  assert.deepEqual(calls, ["a"]); // leading
  assert.equal(t.pending(), 1);

  t.advance(40);
  deb("b");
  t.advance(40);
  deb("c");
  // Still only the leading call; b and c coalesced.
  assert.deepEqual(calls, ["a"]);

  t.advance(100); // completes the wait after the last reschedule
  assert.deepEqual(calls, ["a", "c"]); // trailing with latest args
});

test("leading=true, trailing=false suppresses repeats during cooldown", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    leading: true,
    trailing: false,
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a");
  assert.deepEqual(calls, ["a"]);
  deb("b");
  deb("c");
  assert.deepEqual(calls, ["a"]);

  t.advance(100);
  assert.deepEqual(calls, ["a"]); // no trailing

  // After the window closes, a new call leads again.
  deb("d");
  assert.deepEqual(calls, ["a", "d"]);
});

test("leading=false, trailing=true fires once after quiet", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    leading: false,
    trailing: true,
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a");
  assert.deepEqual(calls, []); // no leading
  t.advance(40);
  deb("b");
  t.advance(40);
  deb("c");
  assert.deepEqual(calls, []);

  t.advance(100);
  assert.deepEqual(calls, ["c"]); // trailing with latest args only
});

test("leading=false, trailing=false never fires", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    leading: false,
    trailing: false,
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a");
  deb("b");
  t.advance(100);
  assert.deepEqual(calls, []);
});

test("cancel clears pending trailing call", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a"); // leading fires
  assert.deepEqual(calls, ["a"]);
  deb("b"); // scheduled trailing
  assert.equal(t.pending(), 1);

  deb.cancel();
  assert.equal(t.pending(), 0);
  t.advance(100);
  assert.deepEqual(calls, ["a"]); // trailing never fired
});

test("flush invokes pending trailing call immediately", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb("a");
  deb("b");
  assert.deepEqual(calls, ["a"]); // leading only so far
  assert.equal(t.pending(), 1);

  const result = deb.flush();
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(t.pending(), 0);
});

test("flush with nothing pending is a no-op returning undefined", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((x) => calls.push(x), 100, {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  // Leading+trailing, but we only call once and let the window fully elapse.
  deb("a");
  t.advance(100); // trailing timer fires, no pending afterward
  assert.deepEqual(calls, ["a"]);
  assert.equal(t.pending(), 0);

  const result = deb.flush();
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["a"]);
});

test("throttle fires on leading edge and at most once per window", () => {
  const calls = [];
  const t = makeFakeTimer();
  const thr = createThrottle((x) => calls.push(x), 100, {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  thr("a");
  assert.deepEqual(calls, ["a"]);
  thr("b"); // within window
  assert.deepEqual(calls, ["a"]);
  t.advance(50);
  thr("c");
  assert.deepEqual(calls, ["a"]);
  t.advance(100); // window after last reschedule closes
  assert.deepEqual(calls, ["a", "c"]); // one trailing with latest args
});

test("thisArg is preserved on leading and trailing calls", () => {
  const seen = [];
  const t = makeFakeTimer();
  const deb = createDebounce(function (x) {
    seen.push({ this: this?.label, arg: x });
  }, 100, {
    leading: true,
    trailing: true,
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  const ctx = { label: "ctx1" };
  deb.call(ctx, "a");
  deb.call(ctx, "b");
  t.advance(100);

  assert.deepEqual(seen, [
    { this: "ctx1", arg: "a" },
    { this: "ctx1", arg: "b" },
  ]);
});

test("invalid arguments throw", () => {
  assert.throws(() => createDebounce(null, 100), TypeError);
  assert.throws(() => createDebounce(() => {}, -1), TypeError);
  assert.throws(() => createDebounce(() => {}, Number.NaN), TypeError);
});

test("two independent instances do not interfere", () => {
  const callsA = [];
  const callsB = [];
  const t = makeFakeTimer();
  const opts = {
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  };
  const a = createDebounce((x) => callsA.push(x), 100, opts);
  const b = createDebounce((x) => callsB.push(x), 200, opts);

  a("a1");
  b("b1");
  assert.deepEqual(callsA, ["a1"]);
  assert.deepEqual(callsB, ["b1"]);

  t.advance(100); // a's window closes, b's does not
  assert.deepEqual(callsA, ["a1"]);
  assert.deepEqual(callsB, ["b1"]);
  t.advance(100); // b's window closes
  assert.deepEqual(callsB, ["b1"]);
});

test("trailing call uses the latest arguments", () => {
  const calls = [];
  const t = makeFakeTimer();
  const deb = createDebounce((...args) => calls.push(args), 100, {
    leading: false,
    trailing: true,
    clock: t.clock,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  deb(1);
  t.advance(20);
  deb(2, "x");
  t.advance(20);
  deb(3, { y: 1 });
  t.advance(100);

  assert.deepEqual(calls, [[3, { y: 1 }]]);
});
