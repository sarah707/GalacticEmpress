export const SCHEMA_VERSION = 3;

export const GENE_FIELDS = Object.freeze([
  'combat', 'acid', 'heat', 'mind', 'cold', 'radiation', 'pressure', 'toxin'
]);

export const RESISTANCE_FIELDS = Object.freeze(GENE_FIELDS.slice(1));

export const ENVIRONMENT_RESISTANCE_FIELDS = Object.freeze([
  'heat', 'cold', 'pressure', 'acid', 'toxin', 'mind'
]);

export const GENE_LABELS = Object.freeze({
  combat: '战斗力', acid: '抗酸', heat: '抗炎热', mind: '抗精神控制',
  cold: '抗寒冷', radiation: '抗辐射', pressure: '抗压', toxin: '抗生物毒素'
});

const RESISTANCE_NAMES = Object.freeze({
  acid: '酸液', heat: '炎热', mind: '精神控制', cold: '寒冷',
  radiation: '辐射', pressure: '压力', toxin: '生物毒素'
});

export const HAZARD_GENE_FIELD = Object.freeze({
  酸液: 'acid', 炎热: 'heat', 精神控制: 'mind', 寒冷: 'cold',
  辐射: 'radiation', 压力: 'pressure', 生物毒素: 'toxin'
});

export const FIXED_CONQUEST_EVENTS = Object.freeze([1, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

export const DEFAULT_PLAYER_APPEARANCE = '黑色长发黑色眼睛肤色白皙身材娇小';
export const DEFAULT_PLAYER_PERSONALITY = '软弱爱哭';
export const MULTI_GENE_CHANCE = 0.05;
export const REINFORCEMENT_CHANCE = 0.1;

export function clampInt(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function uid(prefix = 'item') {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function emptyGene() {
  return Object.fromEntries(GENE_FIELDS.map((field) => [field, 0]));
}

export function normalizeGene(source = {}) {
  return Object.fromEntries(GENE_FIELDS.map((field) => [field, clampInt(source?.[field], 0)]));
}

export function createDefaultState(playerProfile = {}) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { runId: uid('run'), createdAt, updatedAt: createdAt },
    phase: 'setup',
    currentPage: 'genes',
    player: {
      name: '',
      appearance: DEFAULT_PLAYER_APPEARANCE,
      personality: DEFAULT_PLAYER_PERSONALITY,
      suggestedName: String(playerProfile?.name || '').trim(),
      prompt: ''
    },
    year: 1,
    conquest: 0,
    lifeEnergy: 0,
    troops: [],
    genes: [],
    characters: [],
    chapters: [],
    history: [],
    locations: [],
    templateSlots: [null],
    soldierCount: 0,
    nextSector: createSector(0),
    tutorialComplete: false,
    introChapterId: '',
    introDraft: null,
    ended: false,
    pending: null,
    manualSaves: [null, null, null],
    settings: {
      textPresetMode: 'tavern',
      imageEnabled: true,
      promptStrengthEnabled: false,
      debugPrompts: globalThis.__GALACTIC_EMPRESS_BUILD_MODE__ === 'github'
    }
  };
}

// The persistence contract is an allowlist, never a dump of the runtime object.
function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined)
    .map((key) => [key, value[key]]));
}

const CHARACTER_KEYS = [
  'id', 'name', 'age', 'identity', 'hobbies', 'appearance', 'avatarPrompt',
  'socialDynamics', 'speechStyle', 'traits', 'bio', 'sexualPreference',
  'penisDescription'
];

function compactPending(pending) {
  if (!pending) return null;
  if (pending.kind === 'effects') {
    return pick(pending, ['kind', 'chapterId', 'eventType', 'characterIds', 'effect']);
  }
  return {
    ...pick(pending, ['kind', 'recoveryId']),
    request: pick(pending.request, ['type', 'recoveryId', 'characterIds', 'generatedGene', 'effect'])
  };
}

function compactProgress(state, { pending = state.pending } = {}) {
  return {
    ...pick(state, ['phase', 'year', 'conquest', 'lifeEnergy', 'templateSlots',
      'tutorialComplete', 'introChapterId', 'ended']),
    meta: pick(state.meta, ['runId', 'createdAt', 'updatedAt']),
    player: pick(state.player, ['name', 'appearance', 'personality', 'prompt']),
    settings: pick(state.settings, ['textPresetMode', 'imageEnabled', 'promptStrengthEnabled']),
    nextSector: state.nextSector ? {
      ...pick(state.nextSector, ['id', 'forConquest', 'balanceVersion', 'strength']),
      hazards: (state.nextSector.hazards || []).map((hazard) => pick(hazard, ['name', 'value']))
    } : null,
    characters: (state.characters || []).map((character) => pick(character, ['id', 'love', 'health', 'avatarUrl'])),
    genes: (state.genes || []).map((gene) => ({
      ...pick(gene, ['id', 'sourceCharacterId', 'sourceName', 'acquiredAt']), gene: normalizeGene(gene.gene)
    })),
    troops: (state.troops || []).map((troop) => ({
      ...pick(troop, ['id', 'name', 'count', 'sources']), gene: normalizeGene(troop.gene)
    })),
    chapterIds: (state.chapters || []).map((chapter) => chapter.id),
    history: (state.history || []).map((entry) => pick(entry,
      entry.chapterId ? ['id', 'year', 'chapterId'] : ['id', 'year', 'text'])),
    locations: (state.locations || []).map((entry) => pick(entry, ['id', 'text', 'chapterId'])),
    introDraftId: state.introDraft ? `draft:${state.introDraft.recoveryId}` : null,
    pending: compactPending(pending)
  };
}

export function serializeState(input, overrides = {}) {
  const state = input || createDefaultState();
  const manualSaves = overrides.manualSaves ?? state.manualSaves ?? [];
  const archive = new Map();
  const profiles = new Map();
  for (const source of [state, ...manualSaves.map((slot) => slot?.snapshot).filter(Boolean)]) {
    if (source.introDraft) {
      const draft = source.introDraft;
      const id = `draft:${draft.recoveryId}`;
      if (!archive.has(id)) archive.set(id, {
        id, kind: 'intro-draft',
        ...pick(draft, ['characterId', 'title', 'content', 'history', 'location', 'fullText',
          'responseSource', 'helperTextChanged', 'recoveryId', 'createdAt'])
      });
    }
    for (const character of source.characters || []) {
      if (!profiles.has(character.id)) profiles.set(character.id, {
        ...pick(character, CHARACTER_KEYS), gene: normalizeGene(character.gene)
      });
    }
    for (const chapter of source.chapters || []) {
      if (!archive.has(chapter.id)) {
        archive.set(chapter.id, {
          ...pick(chapter, ['id', 'eventType', 'title', 'history', 'characterIds', 'createdAt']),
          content: String(chapter.content || '')
        });
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    current: compactProgress(state, overrides),
    characters: [...profiles.values()],
    // Chapters are immutable and shared by current progress and every slot.
    chapters: [...archive.values()],
    slots: [0, 1, 2].map((index) => {
      const slot = manualSaves[index];
      return slot ? { savedAt: slot.savedAt, state: compactProgress(slot.snapshot, { pending: null }) } : null;
    })
  };
}

function expandProgress(progress, chapters, characters) {
  const archive = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const profiles = new Map(characters.map((character) => [character.id, character]));
  if (progress.introDraftId && !archive.has(progress.introDraftId)) throw new Error('存档的开始剧情草稿不完整。');
  const selectedChapters = (progress.chapterIds || []).map((id) => {
    if (!archive.has(id)) throw new Error('存档的剧情档案不完整。');
    return { ...archive.get(id) };
  });
  return {
    ...progress,
    schemaVersion: SCHEMA_VERSION,
    chapters: selectedChapters,
    introDraft: progress.introDraftId ? { ...archive.get(progress.introDraftId) } : null,
    characters: (progress.characters || []).map((character) => {
      if (!profiles.has(character.id)) throw new Error('存档的角色档案不完整。');
      return { ...profiles.get(character.id), ...character };
    }),
    history: (progress.history || []).map((entry) => entry.chapterId
      ? { ...entry, text: `第${entry.year}天，${archive.get(entry.chapterId)?.history || ''}` }
      : entry)
  };
}

export function patchState(input, playerProfile = {}) {
  const defaults = createDefaultState(playerProfile);
  if (!input || typeof input !== 'object' || input.schemaVersion !== SCHEMA_VERSION) return defaults;
  if (input.current) {
    const stored = input;
    input = expandProgress(stored.current, stored.chapters || [], stored.characters || []);
    input.manualSaves = (stored.slots || []).map((slot) => slot ? {
      savedAt: slot.savedAt,
      snapshot: patchState(expandProgress(slot.state, stored.chapters || [], stored.characters || []), playerProfile)
    } : null);
  }
  const state = {
    ...defaults,
    ...input,
    meta: { ...defaults.meta, ...(input.meta || {}) },
    player: { ...defaults.player, ...(input.player || {}) },
    settings: { ...defaults.settings, ...(input.settings || {}) }
  };
  if (state.phase === 'setup') {
    if (!String(state.player.appearance || '').trim()) state.player.appearance = DEFAULT_PLAYER_APPEARANCE;
    if (!String(state.player.personality || '').trim()) state.player.personality = DEFAULT_PLAYER_PERSONALITY;
  }
  for (const key of ['troops', 'genes', 'characters', 'chapters', 'history', 'locations', 'templateSlots']) {
    if (!Array.isArray(state[key])) state[key] = defaults[key];
  }
  state.manualSaves = Array.isArray(input.manualSaves)
    ? [0, 1, 2].map((index) => {
      const slot = input.manualSaves[index];
      return slot?.savedAt && slot?.snapshot ? slot : null;
    })
    : defaults.manualSaves;
  state.introDraft = input.introDraft && typeof input.introDraft === 'object' ? input.introDraft : null;
  state.year = clampInt(state.year, 1);
  state.conquest = clampInt(state.conquest, 0, 100);
  state.lifeEnergy = clampInt(state.lifeEnergy, 0);
  state.soldierCount = clampInt(state.soldierCount, 0, state.lifeEnergy);
  state.ended = Boolean(state.ended || state.conquest >= 100 && state.phase === 'ended');
  state.troops = state.troops.map((troop) => ({
    ...troop,
    id: troop?.id || uid('troop'),
    count: clampInt(troop?.count, 0),
    gene: normalizeGene(troop?.gene)
  }));
  state.genes = state.genes.map((fragment) => ({
    ...fragment,
    id: fragment?.id || uid('gene'),
    gene: normalizeGene(fragment?.gene)
  }));
  const chapterIdsByCharacter = new Map();
  for (const chapter of state.chapters) {
    for (const characterId of chapter?.characterIds || []) {
      if (!chapterIdsByCharacter.has(characterId)) chapterIdsByCharacter.set(characterId, []);
      chapterIdsByCharacter.get(characterId).push(chapter.id);
    }
  }
  state.characters = state.characters.map((character) => ({
    ...character,
    gender: '男',
    id: character?.id || uid('character'),
    love: clampInt(character?.love, 0, 100),
    health: clampInt(character?.health, 0, 100),
    live: character?.live !== false && clampInt(character?.health, 0, 100) > 0,
    gene: normalizeGene(character?.gene),
    storyIds: chapterIdsByCharacter.get(character?.id) || []
  }));
  state.chapters = state.chapters.map((chapter) => {
    if (!chapter || typeof chapter !== 'object') return chapter;
    const content = String(chapter.content || '');
    return { ...chapter, content, displayContent: content };
  });
  if (state.introDraft) {
    state.introDraft.content = String(state.introDraft.content || '');
    state.introDraft.displayContent = state.introDraft.content;
  }
  if (!state.nextSector || Number(state.nextSector.forConquest) !== state.conquest || state.nextSector.balanceVersion !== 5) {
    state.nextSector = createSector(state.conquest);
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

function randomBetween(min, max, random = Math.random) {
  return min + (max - min) * random();
}

function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function createSector(conquest, random = Math.random) {
  const occupied = clampInt(conquest, 0, 100);
  const targetConquest = Math.min(100, occupied + 1);
  const hazards = [];
  const add = (name, value) => hazards.push({ name, value: Math.max(1, Math.ceil(value)) });
  if (targetConquest >= 10 && targetConquest < 20) add('炎热', (targetConquest - 9) * randomBetween(4.8, 5.2, random) * 100);
  else if (targetConquest >= 20 && targetConquest < 30) add('寒冷', (targetConquest - 19) * randomBetween(4.8, 5.2, random) * 100);
  else if (targetConquest >= 30 && targetConquest < 40) add('压力', (targetConquest - 29) * randomBetween(4.8, 5.2, random) * 200);
  else if (targetConquest >= 40 && targetConquest < 50) add('酸液', (targetConquest - 39) * randomBetween(4.8, 5.2, random) * 200);
  else if (targetConquest >= 50 && targetConquest < 60) add('生物毒素', (targetConquest - 49) * randomBetween(4.8, 5.2, random) * 300);
  else if (targetConquest >= 60 && targetConquest < 70) add('精神控制', (targetConquest - 59) * randomBetween(4.8, 5.2, random) * 300);
  else if (targetConquest >= 70 && targetConquest < 80) {
    for (const name of shuffled(['炎热', '寒冷', '压力', '酸液', '生物毒素', '精神控制'], random).slice(0, 2)) {
      add(name, (targetConquest - 69) * randomBetween(3.8, 4.2, random) * 500);
    }
  } else if (targetConquest >= 80 && targetConquest < 90) {
    for (const name of shuffled(['炎热', '寒冷', '压力', '酸液', '生物毒素', '精神控制'], random).slice(0, 3)) {
      add(name, (targetConquest - 79) * randomBetween(3.8, 4.2, random) * 800);
    }
  } else if (targetConquest >= 90 && targetConquest <= 100) {
    for (const name of shuffled(['炎热', '寒冷', '压力', '酸液', '生物毒素', '精神控制'], random).slice(0, 4)) {
      add(name, (targetConquest - 89) * randomBetween(3.8, 4.2, random) * 1000);
    }
  }
  return {
    id: uid('sector'),
    forConquest: occupied,
    balanceVersion: 5,
    strength: Math.max(1, Math.ceil(targetConquest * 100 * randomBetween(0.9, 1.1, random))),
    hazards
  };
}

export function totalCombatPower(troops = []) {
  return Math.round(troops.reduce((sum, troop) => (
    sum + clampInt(troop?.count, 0) * clampInt(troop?.gene?.combat, 0)
  ), 0));
}

export function totalResistance(troops = [], field) {
  return Math.round(troops.reduce((sum, troop) => (
    sum + clampInt(troop?.count, 0) * clampInt(troop?.gene?.[field], 0)
  ), 0));
}

export function calculateArmyStrength(troops = [], sector = {}) {
  const base = totalCombatPower(troops);
  const hazards = Array.isArray(sector?.hazards) ? sector.hazards : [];
  if (!hazards.length) return { base, effective: base, counters: [] };
  const counters = hazards.map((hazard) => {
    const field = HAZARD_GENE_FIELD[hazard?.name];
    const resistance = field ? totalResistance(troops, field) : 0;
    const value = Math.max(1, clampInt(hazard?.value, 1));
    return { ...hazard, field, resistance, ratio: (1 + 2 * resistance / value) / 3 };
  });
  const weakestRatio = Math.min(...counters.map((item) => item.ratio));
  return { base, effective: Math.floor(base * weakestRatio), counters };
}

export function calculateCasualties(troops = [], sector = {}, effectiveStrength = 0) {
  const enemy = Math.max(0, clampInt(sector?.strength, 0));
  const army = calculateArmyStrength(troops, sector);
  const ours = Math.max(1, Number(effectiveStrength) || army.effective || 0);
  const environmentMultiplier = army.counters.length
    ? Math.min(...army.counters.map((counter) => counter.ratio))
    : 1;
  const fraction = Math.min(1, enemy / ours * 0.05 / Math.max(Number.EPSILON, environmentMultiplier));
  return troops.map((troop) => {
    const count = clampInt(troop?.count, 0);
    const lost = count > 0 ? Math.min(count, Math.ceil(count * fraction - 1e-9)) : 0;
    return { id: troop?.id, name: troop?.name || '未命名虫群', before: count, lost, after: count - lost };
  });
}

export function applyCasualties(troops = [], casualties = []) {
  const losses = new Map(casualties.map((item) => [item.id, clampInt(item.lost, 0)]));
  return troops.map((troop) => ({
    ...troop,
    count: Math.max(0, clampInt(troop?.count, 0) - (losses.get(troop?.id) || 0))
  })).filter((troop) => troop.count > 0);
}

export function requiredReinforcementGene(conquest, genes = []) {
  const occupied = clampInt(conquest, 0, 100);
  const requirements = [
    [11, 'heat'], [21, 'cold'], [31, 'pressure'], [41, 'acid'], [51, 'toxin'], [61, 'mind']
  ];
  for (const [threshold, field] of requirements) {
    if (occupied < threshold) continue;
    const owned = genes.some((fragment) => clampInt(fragment?.gene?.[field], 0) > 0);
    if (!owned) return field;
  }
  return null;
}

export function createCharacterGene(conquest, options = {}) {
  const random = options.random || Math.random;
  const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : 1;
  const mandatory = options.mandatory && ENVIRONMENT_RESISTANCE_FIELDS.includes(options.mandatory)
    ? options.mandatory
    : null;
  const onlyMandatory = Boolean(options.onlyMandatory && mandatory);
  const occupied = clampInt(conquest, 0, 100);
  const gene = emptyGene();
  gene.combat = Math.max(1, Math.ceil((occupied / 10 + 1) * randomBetween(0.8, 1.2, random) * scale));

  const tiers = [
    { min: 10, maxExclusive: 20, field: 'heat', offset: 9, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 20, maxExclusive: 30, field: 'cold', offset: 19, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 30, maxExclusive: 40, field: 'pressure', offset: 29, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 40, maxExclusive: 50, field: 'acid', offset: 39, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 50, maxExclusive: 60, field: 'toxin', offset: 49, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 60, maxExclusive: 70, field: 'mind', offset: 59, count: 1, multiplierMin: 0.8, multiplierMax: 1.5 },
    { min: 70, maxExclusive: 80, offset: 69, count: 2, multiplierMin: 0.6, multiplierMax: 1.2 },
    { min: 80, maxExclusive: 90, offset: 79, count: 3, multiplierMin: 0.6, multiplierMax: 1.2 },
    { min: 90, maxExclusive: 101, offset: 89, count: 4, multiplierMin: 0.6, multiplierMax: 1.2 }
  ];
  const tier = tiers.find((item) => occupied >= item.min && occupied < item.maxExclusive);
  if (!tier) return gene;

  const resistanceValue = () => Math.max(1, Math.ceil(
    (occupied - tier.offset) * randomBetween(tier.multiplierMin, tier.multiplierMax, random) * scale
  ));
  if (onlyMandatory) {
    gene[mandatory] = resistanceValue();
    return gene;
  }

  if (tier.field) {
    gene[tier.field] = resistanceValue();
  } else {
    for (const field of shuffled(ENVIRONMENT_RESISTANCE_FIELDS, random).slice(0, tier.count)) {
      gene[field] = resistanceValue();
    }
  }
  return gene;
}

export function sumGenes(fragments = []) {
  const total = emptyGene();
  for (const fragment of fragments) {
    for (const field of GENE_FIELDS) total[field] += clampInt(fragment?.gene?.[field], 0);
  }
  return total;
}

export function addOrMergeTroop(troops = [], incoming = {}) {
  const normalizedGene = normalizeGene(incoming?.gene);
  const matchingIndex = troops.findIndex((troop) => {
    const troopGene = normalizeGene(troop?.gene);
    return GENE_FIELDS.every((field) => troopGene[field] === normalizedGene[field]);
  });
  const incomingCount = clampInt(incoming?.count, 0);
  if (matchingIndex < 0) {
    const troop = { ...incoming, count: incomingCount, gene: normalizedGene };
    return { troops: [...troops, troop], troop, merged: false };
  }

  const existing = troops[matchingIndex];
  const troop = {
    ...existing,
    count: clampInt(existing?.count, 0) + incomingCount,
    gene: normalizedGene,
    sources: [...new Set([
      ...(Array.isArray(existing?.sources) ? existing.sources : []),
      ...(Array.isArray(incoming?.sources) ? incoming.sources : [])
    ].filter(Boolean))]
  };
  const mergedTroops = [...troops];
  mergedTroops[matchingIndex] = troop;
  return { troops: mergedTroops, troop, merged: true };
}

export function canCreateSoldiers(state = {}) {
  const count = clampInt(state.soldierCount, 0);
  const lifeEnergy = clampInt(state.lifeEnergy, 0);
  const genes = Array.isArray(state.genes) ? state.genes : [];
  const slots = Array.isArray(state.templateSlots) ? state.templateSlots : [];
  const hasSelectedFragment = slots.some((id) => id && genes.some((fragment) => fragment?.id === id));
  return !state.ended && count >= 1 && count <= lifeEnergy && hasSelectedFragment;
}

export function withCacheBust(url, token = Date.now()) {
  const value = String(url || '');
  if (!value) return '';
  const hashIndex = value.indexOf('#');
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  return `${base}${base.includes('?') ? '&' : '?'}avatarVersion=${encodeURIComponent(String(token))}${hash}`;
}

export function geneExtractionEffect(character) {
  const love = clampInt(character?.love, 0, 100);
  return {
    healthLoss: 10,
    lifeEnergy: love * 10,
    fragment: normalizeGene(character?.gene)
  };
}

export function geneExtractionLoveGain(random = Math.random) {
  return Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * 40) + 1;
}

export function godateLoveGain(random = Math.random) {
  return Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * 26) + 5;
}

export function shouldTriggerMultiGene(random = Math.random) {
  const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return roll < MULTI_GENE_CHANCE;
}

export function shouldTriggerReinforcement(random = Math.random) {
  const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return roll < REINFORCEMENT_CHANCE;
}

export function eligibleMultiGenePartners(characters = [], selectedId = '') {
  return characters.filter((character) => (
    character?.id !== selectedId
    && character?.live !== false
    && clampInt(character?.love, 0, 100) === 100
    && clampInt(character?.health, 0, 100) > 10
  ));
}

export function getCharacterRelation(character) {
  const love = clampInt(character?.love, 0, 100);
  if (love < 30) return '憎恨俘虏自己的<user>，谋划逃离';
  if (love < 60) return '对<user>爱恨交织，理智知道自己应该逃离但潜意识不愿离开';
  if (love < 90) return '被<user>深深吸引，明确了自己已经爱上<user>的事实，根据性格可能会唾弃自己也可能会义无反顾';
  return '将<user>视为自己唯一的伴侣，愿意为她献上生命，会为了她的利益去思考并行动';
}

export function getCharacterHealth(character) {
  const health = clampInt(character?.health, 0, 100);
  if (health <= 10) return '非常虚弱，看起来像是快要死了。这个角色有可能在进行交合时死亡，剧情里要暗示这一点。';
  if (health <= 50) return '看起来有些虚弱，会让人有点担心的程度';
  if (health <= 70) return '比平时要稍微疲惫一点';
  return '非常健康';
}

export function describeGene(gene) {
  const value = normalizeGene(gene);
  const lines = [];
  if (value.combat <= 3) lines.push('体质普通。');
  else if (value.combat <= 7) lines.push('体质较为强健，有一定的战斗技巧。');
  else lines.push('极为擅长战斗。');
  for (const field of RESISTANCE_FIELDS) {
    const amount = value[field];
    if (amount < 1) continue;
    const level = amount < 4 ? '有一定的' : amount < 8 ? '有较强的' : '有极强的';
    lines.push(`${level}抵御${RESISTANCE_NAMES[field]}的能力和${RESISTANCE_NAMES[field]}攻击的能力。`);
  }
  if (!RESISTANCE_FIELDS.some((field) => value[field] > 0)) lines.push('没有特殊能力。');
  return lines.join('');
}

export function formatGene(gene, { hideZero = true } = {}) {
  const value = normalizeGene(gene);
  return GENE_FIELDS.filter((field) => !hideZero || value[field] > 0)
    .map((field) => `${GENE_LABELS[field]} ${value[field]}`)
    .join(' · ') || '无';
}

export function isFixedConquestEvent(conquest) {
  return FIXED_CONQUEST_EVENTS.includes(clampInt(conquest, 0, 100));
}
