function oneLine(value, fallback = '无') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function safeName(value) {
  return oneLine(value, '女皇').replace(/[\\/:*?"<>|]/g, '·').slice(0, 32);
}

function stamp(value) {
  const date = new Date(value || Date.now());
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function entry(name, content, options = {}) {
  return {
    name,
    enabled: true,
    strategy: {
      type: options.constant ? 'constant' : 'selective',
      keys: options.keys || [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global'
    },
    position: { type: 'before_character_definition', role: 'system', depth: 4, order: options.order || 100 },
    content,
    probability: 100,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    extra: { source: 'galactic-empress-tavern-card', schemaVersion: 1 }
  };
}

function formatCharacter(character) {
  return [
    '<CharacterProfile>',
    `姓名：${oneLine(character?.name)}`,
    `年龄：${oneLine(character?.age)}`,
    '性别：男',
    `是否存活：${character?.live === false ? '否' : '是'}`,
    `身份：${oneLine(character?.identity)}`,
    `爱好：${oneLine(character?.hobbies)}`,
    `爱情度：${Math.round(Number(character?.love || 0))}`,
    `健康度：${Math.round(Number(character?.health || 0))}`,
    `外貌服饰氛围气味：${oneLine(character?.appearance)}`,
    `性格动力与社交类型：${oneLine(character?.socialDynamics)}`,
    `说话方式与台词示例：${oneLine(character?.speechStyle)}`,
    `核心特质：${oneLine(character?.traits)}`,
    `人物小传：${oneLine(character?.bio)}`,
    `性爱偏好：${oneLine(character?.sexualPreference)}`,
    `阴茎描述：${oneLine(character?.penisDescription)}`,
    '</CharacterProfile>'
  ].join('\n');
}

function replacePlayerName(content, runtime) {
  const playerName = String(runtime?.player?.name || '').trim();
  return playerName ? String(content).split(playerName).join('<user>') : String(content);
}

export function buildExportWorldbook(runtime, promptSettings = {}) {
  const player = safeName(runtime?.player?.name);
  const run = safeName(runtime?.meta?.runId || 'run').slice(0, 12);
  const worldbookName = `女皇的银河·${player}·${stamp(runtime?.meta?.createdAt)}·${run}`;
  const worldBuilding = String(promptSettings?.worldBuilding || '').trim();
  const playerSettings = String(promptSettings?.playerSettings || '').trim();
  if (!worldBuilding || !playerSettings) throw new Error('导出世界书缺少世界观或主角设定。');
  const history = (runtime?.history || [])
    .map((item) => typeof item === 'string' ? item : item?.text)
    .filter(Boolean)
    .join('\n') || '暂无履历记录';
  const locations = (runtime?.locations || [])
    .map((item) => typeof item === 'string' ? item : item?.text)
    .filter(Boolean)
    .join('\n\n') || '暂无地点记录';
  const entries = [
    entry('银河世界观', worldBuilding, { constant: true, order: 150 }),
    entry('女皇设定', playerSettings, { constant: true, order: 140 }),
    entry('帝国履历', `<EmpireHistory>\n${history}\n</EmpireHistory>`, { constant: true, order: 130 }),
    entry('地点资料', `<Locations>\n${locations}\n</Locations>`, { constant: true, order: 120 }),
    ...(runtime?.characters || []).filter((character) => character?.name).map((character, index) => entry(
      `角色·${character.name}`,
      formatCharacter(character),
      { keys: [String(character.name)], order: 110 - index }
    ))
  ];
  return { worldbookName, entries: entries.map((item) => ({ ...item, content: replacePlayerName(item.content, runtime) })) };
}
