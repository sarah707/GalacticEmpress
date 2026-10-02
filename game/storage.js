import { SCHEMA_VERSION, patchState, serializeState } from './game-core.js?build=20261002145614';

export function createManualSaveSnapshot(state) {
  const stored = serializeState(state, {
    manualSaves: [null, null, null],
    pending: null
  });
  return patchState(structuredClone(stored));
}

export function decodeManualSaveSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== SCHEMA_VERSION) throw new Error('手动存档版本与当前游戏不兼容。');
  return serializeState(snapshot);
}
