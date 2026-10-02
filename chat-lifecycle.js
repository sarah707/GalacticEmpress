function collectAccessibleWindows(...seeds) {
  const windows = [];
  for (const seed of seeds) {
    let current = seed;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (!windows.includes(current)) windows.push(current);
      try {
        if (!current.parent || current.parent === current) break;
        current = current.parent;
      } catch {
        break;
      }
    }
  }
  return windows;
}

function collectContexts(hostWindow, apiWindow) {
  const contexts = [];
  for (const candidateWindow of collectAccessibleWindows(apiWindow, hostWindow)) {
    for (const surface of [candidateWindow?.TavernHelper, candidateWindow?.SillyTavern, candidateWindow]) {
      if (typeof surface?.getContext !== 'function') continue;
      try {
        const context = surface.getContext();
        if (context && !contexts.includes(context)) contexts.push(context);
      } catch {
        // Continue through the other same-origin SillyTavern/TavernHelper surfaces.
      }
    }
  }
  return contexts;
}

function normalizeId(value) {
  return value === undefined || value === null || value === '' ? '' : String(value);
}

function makeCharacterKey(context) {
  const groupId = normalizeId(context?.groupId);
  if (groupId) return `group:${groupId}`;

  const characterId = normalizeId(context?.characterId);
  const character = characterId
    ? context?.characters?.[Number.isNaN(Number(characterId)) ? characterId : Number(characterId)]
    : null;
  const stableId = normalizeId(character?.avatar || character?.data?.avatar || characterId);
  return stableId ? `character:${stableId}` : '';
}

export function getActiveChatSnapshot(hostWindow, apiWindow = globalThis) {
  const contexts = collectContexts(hostWindow, apiWindow);
  const context = contexts.find((item) => makeCharacterKey(item)) || contexts[0] || null;
  if (!context) return { chatId: '', characterKey: '' };

  let chatId = '';
  try {
    chatId = normalizeId(context.getCurrentChatId?.() || context.chatId);
  } catch {
    chatId = normalizeId(context.chatId);
  }
  return {
    chatId,
    characterKey: makeCharacterKey(context)
  };
}

export function subscribeToChatChanges(hostWindow, apiWindow, listener) {
  const removers = [];
  const subscribedSources = new Set();
  for (const context of collectContexts(hostWindow, apiWindow)) {
    const eventSource = context?.eventSource;
    const eventName = context?.eventTypes?.CHAT_CHANGED
      || context?.event_types?.CHAT_CHANGED
      || 'chat_id_changed';
    if (!eventSource || typeof eventSource.on !== 'function' || subscribedSources.has(eventSource)) continue;
    eventSource.on(eventName, listener);
    subscribedSources.add(eventSource);
    removers.push(() => {
      if (typeof eventSource.removeListener === 'function') eventSource.removeListener(eventName, listener);
      else if (typeof eventSource.off === 'function') eventSource.off(eventName, listener);
    });
  }
  return () => removers.forEach((remove) => remove());
}
