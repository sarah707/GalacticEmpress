export const REMOVED_AI_PHRASES = Object.freeze(['极其', '极度']);

const REMOVED_AI_PHRASE_PATTERN = /极其|极度/g;

export function sanitizeAiText(text) {
  return String(text ?? '').replace(REMOVED_AI_PHRASE_PATTERN, '');
}

export function makeGenerationId(prefix = 'galactic-empress') {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
