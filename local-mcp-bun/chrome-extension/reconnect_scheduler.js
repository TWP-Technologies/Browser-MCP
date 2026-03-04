// Modified by [KnotFalse]

export function compute_reconnect_delay_ms(
  attempt,
  {
    base_delay_ms = 1000,
    max_delay_ms = 5000,
    jitter_ratio = 0.2,
    random_fn = Math.random,
  } = {},
) {
  const safe_attempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const backoff_delay = Math.min(max_delay_ms, base_delay_ms * Math.pow(2, safe_attempt));
  const jitter_window = Math.max(0, Math.floor(backoff_delay * Math.max(0, jitter_ratio)));
  const jitter = Math.floor(random_fn() * (jitter_window + 1));

  return Math.min(max_delay_ms, backoff_delay + jitter);
}

export class reconnect_scheduler {
  constructor({
    base_delay_ms = 1000,
    max_delay_ms = 5000,
    jitter_ratio = 0.2,
    random_fn = Math.random,
    set_timeout_fn = null,
    clear_timeout_fn = null,
    timer_scope = globalThis,
  } = {}) {
    this.base_delay_ms = base_delay_ms;
    this.max_delay_ms = max_delay_ms;
    this.jitter_ratio = jitter_ratio;
    this.random_fn = random_fn;
    this.timer_scope = timer_scope;
    this.set_timeout_fn = typeof set_timeout_fn === "function" ? set_timeout_fn : globalThis.setTimeout;
    this.clear_timeout_fn = typeof clear_timeout_fn === "function" ? clear_timeout_fn : globalThis.clearTimeout;
    this.timer_id = null;
    this.attempt = 0;
  }

  has_pending_reconnect() {
    return this.timer_id !== null;
  }

  get_attempt() {
    return this.attempt;
  }

  clear() {
    if (this.timer_id === null) {
      return false;
    }

    Reflect.apply(this.clear_timeout_fn, this.timer_scope, [this.timer_id]);
    this.timer_id = null;
    return true;
  }

  reset() {
    this.clear();
    this.attempt = 0;
  }

  schedule(callback) {
    if (this.timer_id !== null) {
      return {
        scheduled: false,
        delay_ms: null,
        attempt: this.attempt,
      };
    }

    const delay_ms = compute_reconnect_delay_ms(this.attempt, {
      base_delay_ms: this.base_delay_ms,
      max_delay_ms: this.max_delay_ms,
      jitter_ratio: this.jitter_ratio,
      random_fn: this.random_fn,
    });

    this.attempt += 1;
    this.timer_id = Reflect.apply(this.set_timeout_fn, this.timer_scope, [
      () => {
        this.timer_id = null;
        callback();
      },
      delay_ms,
    ]);

    return {
      scheduled: true,
      delay_ms,
      attempt: this.attempt,
    };
  }
}
