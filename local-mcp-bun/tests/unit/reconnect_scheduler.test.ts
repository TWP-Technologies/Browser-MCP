import { expect, test } from "bun:test";
import { compute_reconnect_delay_ms, reconnect_scheduler } from "../../chrome-extension/reconnect_scheduler.js";

interface scheduled_timer {
  fn: () => void;
  delay_ms: number;
}

function create_timer_harness() {
  let next_timer_id = 1;
  const timers = new Map<number, scheduled_timer>();

  return {
    set_timeout_fn(fn: () => void, delay_ms: number): number {
      const timer_id = next_timer_id;
      next_timer_id += 1;
      timers.set(timer_id, { fn, delay_ms });
      return timer_id;
    },
    clear_timeout_fn(timer_id: number): void {
      timers.delete(timer_id);
    },
    pending_count(): number {
      return timers.size;
    },
    pending_delays(): number[] {
      return [...timers.values()].map((timer) => timer.delay_ms);
    },
    run_next_timer(): boolean {
      const [timer_id, timer] = timers.entries().next().value ?? [];
      if (typeof timer_id !== "number" || !timer) {
        return false;
      }

      timers.delete(timer_id);
      timer.fn();
      return true;
    },
  };
}

test("compute_reconnect_delay_ms caps at max_delay_ms", () => {
  const delay = compute_reconnect_delay_ms(999, {
    base_delay_ms: 1000,
    max_delay_ms: 5000,
    jitter_ratio: 0.9,
    random_fn: () => 1,
  });

  expect(delay).toBe(5000);
});

test("reconnect_scheduler schedules single reconnect timer", () => {
  const harness = create_timer_harness();
  const scheduler = new reconnect_scheduler({
    set_timeout_fn: harness.set_timeout_fn,
    clear_timeout_fn: harness.clear_timeout_fn,
    random_fn: () => 0,
  });

  const first = scheduler.schedule(() => {});
  const second = scheduler.schedule(() => {});

  expect(first.scheduled).toBe(true);
  expect(first.delay_ms).toBe(1000);
  expect(second.scheduled).toBe(false);
  expect(harness.pending_count()).toBe(1);
});

test("reconnect_scheduler increases backoff and caps at 5s", () => {
  const harness = create_timer_harness();
  const scheduler = new reconnect_scheduler({
    set_timeout_fn: harness.set_timeout_fn,
    clear_timeout_fn: harness.clear_timeout_fn,
    random_fn: () => 0,
  });

  const observed_delays: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const result = scheduler.schedule(() => {});
    expect(result.scheduled).toBe(true);
    observed_delays.push(result.delay_ms as number);
    expect(harness.run_next_timer()).toBe(true);
  }

  expect(observed_delays).toEqual([1000, 2000, 4000, 5000, 5000]);
});

test("reconnect_scheduler clear removes pending timer", () => {
  const harness = create_timer_harness();
  const scheduler = new reconnect_scheduler({
    set_timeout_fn: harness.set_timeout_fn,
    clear_timeout_fn: harness.clear_timeout_fn,
    random_fn: () => 0,
  });

  scheduler.schedule(() => {});
  expect(harness.pending_count()).toBe(1);
  expect(scheduler.clear()).toBe(true);
  expect(harness.pending_count()).toBe(0);
  expect(scheduler.has_pending_reconnect()).toBe(false);
});

test("reconnect_scheduler reset clears timer and attempt counter", () => {
  const harness = create_timer_harness();
  const scheduler = new reconnect_scheduler({
    set_timeout_fn: harness.set_timeout_fn,
    clear_timeout_fn: harness.clear_timeout_fn,
    random_fn: () => 0,
  });

  scheduler.schedule(() => {});
  expect(scheduler.get_attempt()).toBe(1);
  expect(harness.pending_count()).toBe(1);

  scheduler.reset();
  expect(scheduler.get_attempt()).toBe(0);
  expect(harness.pending_count()).toBe(0);
});

test("reconnect_scheduler executes callback once per timer", () => {
  const harness = create_timer_harness();
  const scheduler = new reconnect_scheduler({
    set_timeout_fn: harness.set_timeout_fn,
    clear_timeout_fn: harness.clear_timeout_fn,
    random_fn: () => 0,
  });

  let calls = 0;
  scheduler.schedule(() => {
    calls += 1;
  });

  expect(harness.run_next_timer()).toBe(true);
  expect(calls).toBe(1);
  expect(scheduler.has_pending_reconnect()).toBe(false);
});

test("reconnect_scheduler binds timer functions for context-sensitive runtimes", () => {
  let calls = 0;

  function strict_timer(this: unknown, fn: () => void, _delay_ms: number): number {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }

    fn();
    return 1;
  }

  function strict_clear(this: unknown, _timer_id: number): void {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
  }

  const scheduler = new reconnect_scheduler({
    set_timeout_fn: strict_timer,
    clear_timeout_fn: strict_clear,
    random_fn: () => 0,
  });

  const result = scheduler.schedule(() => {
    calls += 1;
  });

  expect(result.scheduled).toBe(true);
  expect(calls).toBe(1);
});
