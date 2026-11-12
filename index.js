// DSH plugin: auto-retry model requests on transient upstream failures.
// Note: bundle plugins cannot `import 'cordis'`, so no Schema-style Config is
// exported — tune via the `config` field of the insert entry in
// cordis.patch.yml, or edit DEFAULTS below.

const DEFAULTS = {
  enabled: true,
  matchPatterns: [
    'No available channel',   // upstream gateway has no available channel (500)
    'circuit open',           // upstream circuit breaker fast-fail (503)
    'upstream-reset',         // upstream connection reset
    'ECONNRESET',             // TLS / network-level disconnect
    'fetch failed',           // Node fetch network failure
    'Unmarshal chat params',  // gateway failed to parse request body (400 bad_params; error suggests RETRY)
  ],
  initialDelayMs: 3000,
  maxDelayMs: 300000,      // cap a single wait at 5 minutes
  backoffMultiplier: 1.5,
  maxRetries: 0,           // 0 = unlimited retries
  maxRetryMs: 28800000,    // total retry window: 8 hours; 0 = never give up
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('retry cancelled: turn signal aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const logger = ctx.logger('request-retry');
  // consecutive-retry counter per turn: key = payload.turn (object; WeakMap lets finished turns be GC'd)
  const attempts = new WeakMap();

  ctx.on('agent/request-error', async (payload, next) => {
    if (!cfg.enabled) return next();

    const failure = payload?.failure;
    const message = String(failure?.message ?? '');
    const code = String(failure?.code ?? '');

    // user cancellation / abort: never retry, hand back to agent-loop's own handling
    if (payload?.signal?.aborted || /abort|cancel/i.test(code)) return next();

    // unmatched errors (401, invalid params, ...): not ours, fall through
    if (!cfg.matchPatterns.some((pattern) => message.includes(pattern))) return next();

    const turn = payload?.turn;
    const isObj = turn && typeof turn === 'object';
    // state: { attempt, firstAt } — firstAt anchors the total retry window
    let state = isObj ? attempts.get(turn) : undefined;
    const now = Date.now();
    if (!state) {
      state = { attempt: 0, firstAt: now };
      if (isObj) attempts.set(turn, state);
    }

    if (cfg.maxRetries > 0 && state.attempt >= cfg.maxRetries) {
      logger.warn(`max retries (${cfg.maxRetries}) reached, giving up: ${message.slice(0, 200)}`);
      return next();
    }

    // total window: keep retrying within maxRetryMs of the first failure; give up after
    const elapsed = now - state.firstAt;
    if (cfg.maxRetryMs > 0 && elapsed >= cfg.maxRetryMs) {
      logger.warn(
        `retry window ${(cfg.maxRetryMs / 3600000).toFixed(1)}h exhausted (persisted ${Math.round(elapsed / 60000)} min), giving up: ${message.slice(0, 200)}`,
      );
      return next();
    }

    // some circuit breakers report retryAfterSeconds (their probe interval):
    // wait at least that long before resending, so we don't burn the full context for nothing
    const retryAfterMatch = /retryAfterSeconds"?\s*[:=]?\s*(\d+)/.exec(message);
    const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 + 2000 : 0;
    const delay = Math.min(
      Math.max(
        cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, state.attempt),
        retryAfterMs,
      ),
      cfg.maxDelayMs,
    );
    state.attempt += 1;

    logger.warn(
      `upstream temporarily unavailable (retry #${state.attempt}, persisted ${Math.round(elapsed / 60000)} min, waiting ${Math.round(delay / 1000)}s): ${message.slice(0, 200)}`,
    );

    try {
      await sleep(delay, payload?.signal);
    } catch {
      // the turn was cancelled while waiting: don't take over, let the abort finish normally
      return next();
    }

    // we own the decision: don't call next(); return retry so agent-loop resends the same request
    return { kind: 'retry' };
  });

  logger.info('request-error auto-retry mounted (patterns: %s)', cfg.matchPatterns.join(', '));
}
