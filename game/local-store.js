const DATABASE_NAME = 'galactic-empress-v3';
const STORE_NAME = 'records';

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('本机存档事务已取消。'));
    transaction.onerror = () => {}; // onabort is the final failure signal.
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** One atomic transaction for progress, changed chapters and changed slots.
 * The chat prefix isolates conversations. No generated request payloads, image
 * binaries or UI caches live here (user-authored/character prompts are game data).
 */
export function createLocalStore({ indexedDB = globalThis.indexedDB, name = DATABASE_NAME } = {}) {
  let opening;
  async function database() {
    if (!indexedDB) throw new Error('浏览器未开放 IndexedDB，无法保存本机进度。');
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE_NAME, { keyPath: ['chatId', 'key'] });
          store.createIndex('chatId', 'chatId');
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      }).catch((error) => { opening = null; throw error; });
    }
    return opening;
  }

  function requireChat(chatId) {
    if (!chatId) throw new Error('尚未识别当前酒馆对话，已停止存档以免写入错误位置。');
  }

  return {
    async load(chatId) {
      requireChat(chatId);
      const db = await database();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const done = completed(tx);
      const [records] = await Promise.all([
        requestResult(tx.objectStore(STORE_NAME).index('chatId').getAll(chatId)), done
      ]);
      const values = new Map(records.map((record) => [record.key, record.value]));
      const current = values.get('current');
      if (!current) return null;
      return {
        schemaVersion: 3,
        current,
        characters: records.filter((record) => record.key.startsWith('character:')).map((record) => record.value),
        chapters: records.filter((record) => record.key.startsWith('chapter:')).map((record) => record.value),
        slots: [0, 1, 2].map((index) => values.get(`slot:${index}`) || null)
      };
    },

    async save(chatId, snapshot) {
      requireChat(chatId);
      if (snapshot?.schemaVersion !== 3 || !snapshot.current) throw new Error('本机存档结构无效。');
      const records = new Map([
        ['current', snapshot.current],
        ...snapshot.characters.map((character) => [`character:${character.id}`, character]),
        ...snapshot.chapters.map((chapter) => [`chapter:${chapter.id}`, chapter]),
        ...snapshot.slots.flatMap((slot, index) => slot ? [[`slot:${index}`, slot]] : [])
      ]);
      const db = await database();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const done = completed(tx);
      const store = tx.objectStore(STORE_NAME);
      let writes = 0;
      let deletes = 0;
      // Compare within the same transaction; no stale in-memory cache across tabs.
      const request = store.index('chatId').getAll(chatId);
      request.onsuccess = () => {
        try {
          const previous = new Map(request.result.map((record) => [record.key, record.value]));
          for (const [key, value] of records) {
            if (JSON.stringify(previous.get(key)) !== JSON.stringify(value)) {
              store.put({ chatId, key, value });
              writes += 1;
            }
          }
          for (const key of previous.keys()) {
            if (!records.has(key)) { store.delete([chatId, key]); deletes += 1; }
          }
        } catch {
          tx.abort();
        }
      };
      await done;
      return { writes, deletes };
    }
  };
}
