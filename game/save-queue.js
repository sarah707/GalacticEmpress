/**
 * Create a latest-wins asynchronous save queue.
 *
 * Snapshots are ordered by revision and are expected to be cumulative: a newer
 * snapshot contains every state change represented by older pending snapshots.
 * At most one write is active and one (the newest) snapshot is kept pending.
 *
 * @param {(snapshot: unknown, revision: number) => unknown | Promise<unknown>} writeSnapshot
 */
export function createLatestWinsSaveQueue(writeSnapshot) {
  if (typeof writeSnapshot !== 'function') {
    throw new TypeError('writeSnapshot must be a function.');
  }

  let latestRevision = 0;
  let inFlight = null;
  let pending = null;
  let flushWaiters = [];
  let idleWaiters = [];

  function settleFlushes(revision, succeeded, error) {
    const covered = [];
    const remaining = [];
    for (const waiter of flushWaiters) {
      (waiter.revision <= revision ? covered : remaining).push(waiter);
    }
    flushWaiters = remaining;

    for (const waiter of covered) {
      if (succeeded) waiter.resolve({ requestedRevision: waiter.revision, writtenRevision: revision });
      else waiter.reject(error);
    }
  }

  function settleIdle() {
    if (inFlight || pending) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function run(entry) {
    let succeeded = false;
    let failure;
    try {
      await writeSnapshot(entry.snapshot, entry.revision);
      succeeded = true;
    } catch (error) {
      failure = error;
    }

    settleFlushes(entry.revision, succeeded, failure);

    inFlight = null;
    const next = pending;
    pending = null;
    if (next) start(next);
    else settleIdle();
  }

  function start(entry) {
    inFlight = entry;
    // run catches both synchronous throws and asynchronous rejections from the
    // writer. Keeping its promise private prevents ordinary enqueue failures
    // from becoming unhandled rejections.
    void run(entry);
  }

  function submit(snapshot, waitForWrite) {
    const revision = ++latestRevision;
    let completion;
    if (waitForWrite) {
      completion = new Promise((resolve, reject) => {
        flushWaiters.push({ revision, resolve, reject });
      });
    }

    const entry = { revision, snapshot };
    if (inFlight) pending = entry;
    else start(entry);

    return waitForWrite ? completion : revision;
  }

  return Object.freeze({
    /** Queue a snapshot without exposing a rejecting promise. */
    enqueue(snapshot) {
      return submit(snapshot, false);
    },

    /**
     * Queue a critical snapshot and wait until a write covering its revision
     * succeeds. A newer pending snapshot may cover this request.
     */
    flush(snapshot) {
      return submit(snapshot, true);
    },

    /** Wait until no write or pending snapshot remains, regardless of errors. */
    whenIdle() {
      if (!inFlight && !pending) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    }
  });
}
