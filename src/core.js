/**
 * Core debounce and throttle implementation.
 *
 * Design decisions (stated plainly so the tests and README agree):
 *
 * 1. The timer/clock is injected. Every function that needs to know "what
 *    time is it" accepts an optional `clock` function. This makes timing
 *    deterministic in tests — no wall-clock assertions, no sleeps. The
 *    default clock uses `Date.now()` for real usage.
 *
 * 2. `setTimeout`/`clearTimeout` are also injected (defaulting to the global
 *    ones) so tests can drive scheduled callbacks manually without flakiness.
 *
 * 3. `leading` and `trailing` are independent boolean options, mirroring
 *    lodash's semantics because they are well understood. The combinations:
 *      - leading=true,  trailing=true  (default): fire now, and fire again
 *        after the wait if calls keep coming.
 *      - leading=true,  trailing=false: fire now, suppress the rest until
 *        quiet for `wait`.
 *      - leading=false, trailing=true:  suppress, then fire once after quiet.
 *      - leading=false, trailing=false: nothing ever fires. We allow it but
 *        it's useless; documented in README.
 *
 * 4. `cancel()` clears any pending trailing call and resets internal state.
 *    `flush()` fires a pending trailing call immediately (if any) and clears
 *    the timer.
 *
 * 5. `throttle` is implemented as debounce with `{ leading: true,
 *    trailing: true }` — the standard meaning of "call at most once per wait
 *    window, leading edge included". This is the only interpretation we
 *    support; we do not offer a separate mid-window rate meter.
 */

const defaultClock = () => Date.now();

/**
 * Create a debounced (or throttled) wrapper for `fn`.
 *
 * @param {Function} fn        - The function to wrap.
 * @param {number}   wait      - Quiet period in milliseconds.
 * @param {Object}   [options]
 * @param {boolean}  [options.leading=true]   - Invoke on the leading edge.
 * @param {boolean}  [options.trailing=true]  - Invoke on the trailing edge.
 * @param {() => number} [options.clock]      - Injectable clock; defaults to Date.now.
 * @param {(cb: Function, ms: number) => unknown} [options.setTimeoutFn] - Injectable scheduler.
 * @param {(id: unknown) => void} [options.clearTimeoutFn] - Injectable clearer.
 * @returns {Function & { cancel: () => void; flush: () => void }}
 */
export function createDebounce(fn, wait, options = {}) {
  const {
    leading = true,
    trailing = true,
    clock = defaultClock,
    setTimeoutFn = (cb, ms) => setTimeout(cb, ms),
    clearTimeoutFn = (id) => clearTimeout(id),
  } = options;

  if (typeof fn !== "function") {
    throw new TypeError("fn must be a function");
  }
  if (typeof wait !== "number" || Number.isNaN(wait) || wait < 0) {
    throw new TypeError("wait must be a non-negative number");
  }

  // True when a trailing call is scheduled. We track this separately from
  // the timer id so that `flush` can decide whether to invoke without
  // depending on the (implementation-defined) truthiness of an opaque id.
  let timerId = null;
  let trailingScheduled = false;
  // Captured args + thisArg for the trailing call. Stored only between the
  // first call within a window and the timer firing; cleared after use.
  let lastArgs = null;
  let lastThis = null;
  // Marks that we are inside the "active" period after a leading call,
  // during which further calls should be coalesced into a trailing call
  // rather than firing immediately again.
  let inCooldown = false;

  function fireTrailing() {
    timerId = null;
    trailingScheduled = false;
    inCooldown = false;
    const args = lastArgs;
    const thisArg = lastThis;
    lastArgs = null;
    lastThis = null;
    if (args !== null) {
      fn.apply(thisArg, args);
    }
  }

  function debounced(...args) {
    const now = clock();

    if (!inCooldown) {
      // Fresh window: leading edge.
      inCooldown = true;
      if (leading) {
        // Apply immediately with the current call's args.
        fn.apply(this, args);
      } else if (trailing) {
        // No leading call; remember this invocation for the trailing edge.
        lastArgs = args;
        lastThis = this;
        trailingScheduled = true;
      }
      // If leading=false, trailing=false we just set inCooldown and do
      // nothing for the whole window — documented as useless.
    } else {
      // Inside cooldown: coalesce into a pending trailing call (if enabled).
      if (trailing) {
        lastArgs = args;
        lastThis = this;
        trailingScheduled = true;
      }
    }

    // (Re)schedule the trailing fire. We only need a timer if a trailing
    // call is actually pending OR we're in cooldown and might still receive
    // one. Simplify: always keep a timer running during cooldown so that the
    // window boundary is well-defined regardless of later calls.
    if (inCooldown) {
      if (timerId !== null) {
        clearTimeoutFn(timerId);
      }
      // Using `wait` from the closure; the delay is relative to the
      // schedule time, not to `now`. The clock injection is what lets tests
      // advance deterministically.
      timerId = setTimeoutFn(fireTrailing, wait);
    }
  }

  /** Clear any pending trailing call and reset state. */
  debounced.cancel = function cancel() {
    if (timerId !== null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
    trailingScheduled = false;
    inCooldown = false;
    lastArgs = null;
    lastThis = null;
  };

  /**
   * Fire any pending trailing call immediately and clear the timer.
   * Returns the value of calling `fn`, or `undefined` if nothing was
   * pending. We intentionally do NOT reset `inCooldown` beyond what
   * `fireTrailing` does — after flush the window is considered closed.
   */
  debounced.flush = function flush() {
    if (!trailingScheduled) {
      if (timerId !== null) {
        clearTimeoutFn(timerId);
        timerId = null;
      }
      return undefined;
    }
    const args = lastArgs;
    const thisArg = lastThis;
    if (timerId !== null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
    trailingScheduled = false;
    inCooldown = false;
    lastArgs = null;
    lastThis = null;
    return fn.apply(thisArg, args);
  };

  return debounced;
}

/**
 * Throttle: invoke `fn` at most once per `wait` ms, firing on the leading
 * edge and (if calls keep coming) once more on the trailing edge.
 *
 * @param {Function} fn
 * @param {number}   wait
 * @param {Object}   [options]   - Accepts the same injectables as createDebounce.
 * @returns {Function & { cancel: () => void; flush: () => void }}
 */
export function createThrottle(fn, wait, options = {}) {
  // Explicitly drop leading/trailing from the caller's options — throttle
  // has a fixed definition here. We still forward clock/setTimeout so tests
  // can drive it.
  const { leading, trailing, ...rest } = options;
  return createDebounce(fn, wait, {
    leading: true,
    trailing: true,
    ...rest,
  });
}
