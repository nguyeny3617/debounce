# debounce

Small ESM TypeScript/JavaScript utilities for leading/trailing debounce and throttle. Zero runtime dependencies.

## Usage

```js
import { createDebounce, createThrottle } from "debounce";

// Defaults: leading + trailing (lodash-style).
const save = createDebounce((text) => console.log("save", text), 250);
save("hello"); // fires immediately on the leading edge

// Fire at most once per 100ms, including a trailing catch-up call.
const onScroll = createThrottle(() => console.log("scroll"), 100);
onScroll(); // fires immediately on the leading edge

// Cancel a pending trailing call, or fire it immediately:
save.cancel();
save.flush();
```

Both factories return a function with two attached methods: `.cancel()` and `.flush()`.

## Why

The standard need: coalesce a burst of calls into one. There are two well-known edges — fire on the first call (leading), fire once after things go quiet (trailing) — and the libraries that ship both tend to be large or to pull in runtime deps. This one is a single file, exports exactly `createDebounce` and `createThrottle`, and lets you inject the clock and the scheduler so tests are deterministic.

The trade-off: `throttle` is defined here as debounce with `{ leading: true, trailing: true }` — i.e. "at most one invocation per `wait` window, leading edge included, plus one trailing call if the burst continues." It is not a separate mid-window rate meter. If you need evenly-spaced sampling, this is not that.

## Options

`createDebounce(fn, wait, options?)` accepts:

- `leading` (default `true`)
- `trailing` (default `true`)
- `clock` (default `() => Date.now()`) — injectable now-function for tests
- `setTimeoutFn` / `clearTimeoutFn` (default the global ones)

`createThrottle(fn, wait, options?)` accepts the same injectables; its `leading`/`trailing` are fixed to `true`.

## Edge you will hit

With `leading: false, trailing: false` the wrapped function will never be called at all. We allow the combination rather than throwing, but it's a no-op — don't set both false.

`.flush()` fires a pending trailing call immediately and clears the timer; if nothing is pending it returns `undefined` and does nothing.
