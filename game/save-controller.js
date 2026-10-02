import { createLatestWinsSaveQueue } from './save-queue.js?build=20261002150215';

/** Local durability is the interaction boundary. Tavern is a background replica. */
export function createSaveController({ writeLocal, writeRemote, onError = () => {}, delay = 500 }) {
  let timer = null;
  let scheduled = null;
  let latest = null;
  let submitted = null;
  let remoteDirty = false;
  const remote = createLatestWinsSaveQueue(async (snapshot) => {
    try {
      await writeRemote(snapshot);
      if (latest === snapshot) remoteDirty = false;
    } catch (error) {
      remoteDirty = true;
      if (submitted === snapshot) submitted = null;
      onError('remote', error);
      throw error;
    }
  });

  function syncNow() {
    clearTimeout(timer);
    timer = null;
    const snapshot = scheduled || (remoteDirty ? latest : null);
    scheduled = null;
    if (snapshot && snapshot !== submitted) {
      submitted = snapshot;
      remote.enqueue(snapshot);
    }
  }

  function schedule(snapshot) {
    latest = snapshot;
    scheduled = snapshot;
    remoteDirty = true;
    clearTimeout(timer);
    timer = setTimeout(syncNow, delay);
  }

  const local = createLatestWinsSaveQueue(async (snapshot) => {
    try {
      await writeLocal(snapshot);
    } catch (error) {
      // Still attempt the remote backup, but never report local success.
      schedule(snapshot);
      onError('local', error);
      throw error;
    }
    schedule(snapshot);
  });

  return Object.freeze({
    save(snapshot) { return local.flush(snapshot); },
    syncNow,
    whenLocalIdle: () => local.whenIdle(),
    whenRemoteIdle: () => remote.whenIdle()
  });
}
