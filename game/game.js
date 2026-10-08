import {
  DEFAULT_PLAYER_APPEARANCE,
  DEFAULT_PLAYER_PERSONALITY,
  GENE_FIELDS,
  GENE_LABELS,
  addOrMergeTroop,
  applyCasualties,
  canCreateSoldiers,
  calculateArmyStrength,
  calculateCasualties,
  clampInt,
  createCharacterGene,
  createDefaultState,
  createSector,
  eligibleMultiGenePartners,
  formatGene,
  geneExtractionEffect,
  geneExtractionLoveGain,
  isFixedConquestEvent,
  patchState,
  requiredReinforcementGene,
  shouldTriggerMultiGene,
  shouldTriggerReinforcement,
  serializeState,
  sumGenes,
  totalCombatPower,
  uid,
  withCacheBust
} from './game-core.js';
import {
  WORLD_BUILDING,
  buildAvatarPrompt,
  buildExportedAvatarPrompt,
  buildEventPayload,
  defaultPlayerPrompt,
  normalizeGeneratedCharacter,
  parseEventOutput
} from './prompts.js';
import { copyTextToClipboard } from './clipboard.js';
import { createManualSaveSnapshot, decodeManualSaveSnapshot } from './storage.js';
import { createLocalStore } from './local-store.js';
import { createSaveController } from './save-controller.js';
import { normalizePortableImageUrls } from '../storage-codec.js';

const app = document.querySelector('#app');
const modalLayer = document.querySelector('#modal-layer');
const loadingLayer = document.querySelector('#loading-layer');
const loadingNote = document.querySelector('#loading-note');
const toasts = document.querySelector('#toasts');

let state = createDefaultState();
let chatId = '';
let runtimeVersions = {};
let busy = false;
let modalContext = null;
let modalReturnFocus = null;
let storageErrorShown = false;

const avatarJobs = new Set();
const localStore = createLocalStore();
const saves = createSaveController({
  writeLocal: ({ chatId, data }) => localStore.save(chatId, data),
  writeRemote: writeRemoteSnapshot,
  onError: (target, error) => {
    if (target === 'local') {
      toast(`本机保存失败，请暂勿关闭游戏：${error.message}`, 'error');
    } else if (!storageErrorShown) {
      storageErrorShown = true;
      toast(`酒馆后台同步失败，稍后将重试：${error.message}`, 'error');
    }
  }
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `${url} 请求失败（HTTP ${response.status}）`);
  return body;
}

function newerStoredState(remoteState, localState) {
  if (!remoteState) return localState;
  if (!localState) return remoteState;
  const remoteUpdatedAt = Date.parse(remoteState?.current?.meta?.updatedAt || '') || 0;
  const localUpdatedAt = Date.parse(localState?.current?.meta?.updatedAt || '') || 0;
  return localUpdatedAt > remoteUpdatedAt ? localState : remoteState;
}

function createSaveSnapshot() {
  state.meta.updatedAt = new Date(Math.max(Date.now(), (Date.parse(state.meta.updatedAt) || 0) + 1)).toISOString();
  return { chatId, data: normalizePortableImageUrls(serializeState(state)) };
}

async function writeRemoteSnapshot(snapshot) {
  await fetchJson('/api/card-storage/chat', {
    method: 'POST', body: JSON.stringify(snapshot)
  });
  storageErrorShown = false;
}

function queueSave() {
  void saves.save(createSaveSnapshot()).catch(() => {});
}

async function saveNow() {
  await saves.save(createSaveSnapshot());
}

function toast(message, tone = '') {
  const item = document.createElement('div');
  item.className = `toast ${tone}`.trim();
  item.textContent = String(message || '');
  toasts.append(item);
  setTimeout(() => item.remove(), 1000);
}

function setLoading(active, note = '请不要关闭或操作游戏窗口') {
  busy = Boolean(active);
  loadingLayer.hidden = !busy;
  loadingNote.textContent = note;
}

function shell(content, { navigation = false } = {}) {
  return `<div class="shell">
    <main class="viewport">${content}</main>
    ${navigation ? renderBottomNav() : ''}
  </div>`;
}

function render() {
  if (state.phase === 'intro') {
    app.innerHTML = shell(`<div class="screen-center"><section class="intro-panel">
      <div class="intro-copy">母皇基因崩溃同时
她巨大的帝国也崩碎了。
我的伴生雄虫保护着我逃到了帝国边陲的荒凉星球上
我所拥有的只剩下一台士兵克隆机器，我唯一的臣下，
和我自己的身体。</div>
      <button class="btn wide" data-action="start-game" type="button">开始</button>
    </section></div>`);
    return;
  }
  if (state.phase === 'setup') {
    const setupPresetModeLabel = state.settings.textPresetMode === 'builtin' ? '使用角色卡自带预设' : '使用当前酒馆预设';
    app.innerHTML = shell(`<div class="screen-center"><form class="setup-panel" data-form="player-setup">
      <h2>主角设置</h2>
      <div class="field"><label for="player-name">请设定姓名</label><input id="player-name" name="name" maxlength="30" required value="${escapeHtml(state.player.suggestedName || '')}"></div>
      <div class="field"><label for="player-appearance">请设定外貌</label><textarea id="player-appearance" name="appearance" maxlength="1000" required>${escapeHtml(state.player.appearance || DEFAULT_PLAYER_APPEARANCE)}</textarea></div>
      <div class="field"><label for="player-personality">请设定性格</label><textarea id="player-personality" name="personality" maxlength="1000" required>${escapeHtml(state.player.personality || DEFAULT_PLAYER_PERSONALITY)}</textarea></div>
      <div class="field"><label>文字生成预设</label><button class="btn secondary wide" data-action="setup-switch-preset-mode" type="button">当前：${setupPresetModeLabel}（点击切换）</button></div>
      <button class="btn wide" type="submit">确定并开始帝国</button>
    </form></div>`);
    return;
  }
  const page = state.currentPage === 'template' ? renderTemplatePage()
    : state.currentPage === 'settings' ? renderSettingsPage()
      : renderCharactersPage();
  app.innerHTML = shell(`${renderTop()}${page}`, { navigation: true });
}

function renderTop() {
  const sector = state.nextSector || createSector(state.conquest);
  const hazards = sector.hazards?.length
    ? sector.hazards.map((item) => `${item.name} ${Math.round(item.value)}`).join('，')
    : '无环境威胁';
  const attackDisabled = !state.tutorialComplete || state.ended;
  const recruitDisabled = attackDisabled || state.conquest <= 10 || Boolean(state.pending);
  return `<section class="topbar">
    <button class="stat stat-button" type="button" data-action="show-army" ${state.ended ? 'disabled' : ''}><span>兵力</span><strong>${totalCombatPower(state.troops)}</strong></button>
    <div class="stat" data-stat="life-energy"><span>生命能量</span><strong>${Math.max(0, Math.round(Number(state.lifeEnergy) || 0))}</strong></div>
    <div class="stat"><span>宇宙占有度</span><strong>${Math.round(state.conquest)}%</strong></div>
    <div class="sector"><strong>下个星域</strong>　战斗力 ${Math.round(sector.strength)}，${escapeHtml(hazards)}</div>
    <div class="topbar-actions">
      <button class="btn attack" type="button" data-action="attack" ${attackDisabled ? 'disabled' : ''}>进攻下一个星域</button>
      <button class="btn" type="button" data-action="recruit" ${recruitDisabled ? 'disabled' : ''}>充实后宫</button>
    </div>
  </section>`;
}

function renderBottomNav() {
  const templateLocked = !state.tutorialComplete;
  const nav = [
    ['genes', '获取基因', false],
    ['template', '生产士兵', templateLocked],
    ['settings', '设置', false]
  ];
  return `<nav class="bottom-nav">${nav.map(([page, label, locked]) => (
    `<button class="nav-btn ${state.currentPage === page ? 'active' : ''}" data-action="navigate" data-page="${page}" type="button" ${locked ? 'disabled' : ''}>${label}</button>`
  )).join('')}</nav>`;
}

function meter(label, value, type = '') {
  const amount = clampInt(value, 0, 100);
  return `<div class="meter"><span>${label} ${amount}</span><div class="bar ${type}"><i style="width:${amount}%"></i></div></div>`;
}

function renderCharacterCard(character, index) {
  const frozen = state.ended;
  const dead = character.live === false || character.health <= 0;
  const tutorialTarget = !state.tutorialComplete && index === 0;
  const disableGeneExtraction = frozen || dead || (!state.tutorialComplete && !tutorialTarget);
  const disableOtherInteraction = frozen || dead || !state.tutorialComplete;
  const avatar = character.avatarUrl
    ? `<button class="avatar-preview-trigger" type="button" data-action="view-avatar" data-id="${character.id}" aria-label="查看${escapeHtml(character.name)}头像大图"><img class="avatar" src="${escapeHtml(character.avatarUrl)}" alt="${escapeHtml(character.name)}头像"></button>`
    : '<div class="avatar-placeholder" aria-label="暂无头像">✦</div>';
  return `<article class="character-card ${dead ? 'dead' : ''}">
    ${dead ? '<span class="dead-mark">已死亡</span>' : ''}
    <div>${avatar}<div class="avatar-actions">
      <button class="btn secondary mini" data-action="generate-avatar" data-id="${character.id}" ${frozen || avatarJobs.has(character.id) ? 'disabled' : ''}>${avatarJobs.has(character.id) ? '头像生成中' : '重新生成头像'}</button>
      <button class="btn secondary mini" data-action="upload-avatar" data-id="${character.id}" ${frozen ? 'disabled' : ''}>上传头像</button>
      <button class="btn ghost mini" data-action="export-avatar-prompt" data-id="${character.id}" ${frozen ? 'disabled' : ''}>导出头像提示词</button>
    </div></div>
    <div class="character-info">
      <h3>${escapeHtml(character.name)}</h3>
      <div class="meters">${meter('爱情度', character.love)}${meter('健康度', character.health, 'health')}</div>
      <p class="detail"><strong>身份：</strong>${escapeHtml(character.identity || '无')}</p>
      <p class="detail"><strong>爱好：</strong>${escapeHtml(character.hobbies || '无')}</p>
      <p class="detail"><strong>基因：</strong>${escapeHtml(formatGene(character.gene))}</p>
      <p class="detail bio">${escapeHtml(character.bio || '无')}</p>
      <div class="char-actions">
        <button class="btn" data-action="extract-gene" data-id="${character.id}" ${disableGeneExtraction ? 'disabled' : ''}>获取基因</button>
        <button class="btn secondary" data-action="give-energy" data-id="${character.id}" ${disableOtherInteraction || state.lifeEnergy < 1000 ? 'disabled' : ''}>赋予生命能量</button>
        <button class="btn secondary" data-action="show-history" data-id="${character.id}" ${character.storyIds?.length ? '' : 'disabled'}>过往剧情</button>
      </div>
    </div>
  </article>`;
}

function renderCharactersPage() {
  return `<section class="panel content-panel">
    ${state.ended ? '<div class="frozen">你已经统治整个宇宙。本局已冻结；仍可查看过往剧情或打开设置。若要重玩，请在酒馆中新建对话。</div>' : ''}
    ${!state.tutorialComplete ? '<div class="locked-note">点击唯一伴生雄虫的“获取基因”，揭示最初的剧情并完成第一次基因获取。</div>' : ''}
    <h2>后宫与基因</h2>
    <div class="character-list">${state.characters.length
      ? state.characters.map(renderCharacterCard).join('')
      : '<div class="empty">银河尚且寂静，等待第一位角色出现。</div>'}</div>
  </section>`;
}

function renderSlot(fragmentId, index) {
  const fragment = state.genes.find((item) => item.id === fragmentId);
  return `<div class="slot"><strong>槽位 ${index + 1}</strong><p class="detail">${fragment
    ? `${escapeHtml(fragment.sourceName)} · ${escapeHtml(formatGene(fragment.gene))}`
    : '尚未选择基因片段'}</p>
    <button class="btn secondary" data-action="pick-gene" data-slot="${index}" ${state.ended ? 'disabled' : ''}>${fragment ? '更换基因片段' : '选择基因片段'}</button>
    ${fragment ? `<button class="btn ghost" data-action="clear-slot" data-slot="${index}" ${state.ended ? 'disabled' : ''}>清空</button>` : ''}</div>`;
}

function renderTemplatePage() {
  const selected = state.templateSlots.map((id) => state.genes.find((item) => item.id === id)).filter(Boolean);
  const canCreate = canCreateSoldiers(state);
  return `<section class="panel content-panel">
    ${state.ended ? '<div class="frozen">通关后模版只读，不能继续孵化或更改虫群。</div>' : ''}
    <h2>基因模版</h2>
    <div class="template-slots">${state.templateSlots.map(renderSlot).join('')}</div>
    <div class="actions" style="margin-top:10px"><button class="btn secondary" data-action="add-slot" ${state.ended || state.lifeEnergy < 10000 ? 'disabled' : ''}>增加基因模版槽位（10000生命能量）</button></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
    <div class="field"><label>生成士兵数量</label><div class="range-row">
      <input data-action="soldier-range" type="range" min="0" max="${Math.max(0, state.lifeEnergy)}" value="${state.soldierCount}" ${state.ended ? 'disabled' : ''}>
      <input data-action="soldier-number" type="number" min="0" max="${Math.max(0, state.lifeEnergy)}" value="${state.soldierCount}" ${state.ended ? 'disabled' : ''}>
    </div></div>
    <p class="detail"><strong>合成属性：</strong>${escapeHtml(selected.length ? formatGene(sumGenes(selected)) : '请先选择片段')}</p>
    <button class="btn wide" data-action="create-soldiers" ${canCreate ? '' : 'disabled'}>生成士兵</button>
  </section>`;
}

function promptStrengthLabel() {
  return `${state.settings.promptStrengthEnabled ? '关闭' : '开启'}破甲力度`;
}

function promptStrengthStatus() {
  return state.settings.promptStrengthEnabled
    ? '已开启：发送时携带最近6章剧情。'
    : '已关闭：发送时只携带最近1章剧情。';
}

function promptStrengthButton() {
  return `<button class="btn secondary wide" type="button" data-action="toggle-prompt-strength" aria-pressed="${state.settings.promptStrengthEnabled}">${promptStrengthLabel()}</button>`;
}

function togglePromptStrength() {
  state.settings.promptStrengthEnabled = !state.settings.promptStrengthEnabled;
  // Update only this control so unsaved preset/player prompt edits stay intact.
  const button = app.querySelector('[data-action="toggle-prompt-strength"]');
  if (button) {
    button.textContent = promptStrengthLabel();
    button.setAttribute('aria-pressed', String(state.settings.promptStrengthEnabled));
  }
  const status = app.querySelector('[data-prompt-strength-status]');
  if (status) status.textContent = promptStrengthStatus();
  queueSave();
}

function renderSettingsPage() {
  const prompt = state.player.prompt || defaultPlayerPrompt(state.player);
  return `<section class="panel content-panel settings-grid">
    <div class="setting-card"><h2>文字生成</h2><form data-form="prompt-settings">
      <div class="field"><label>预设模式</label><select name="textPresetMode">
        <option value="tavern" ${state.settings.textPresetMode === 'tavern' ? 'selected' : ''}>使用当前酒馆预设</option>
        <option value="builtin" ${state.settings.textPresetMode === 'builtin' ? 'selected' : ''}>使用角色卡自带预设</option>
      </select></div>
      <div class="field">${promptStrengthButton()}<span class="small" data-prompt-strength-status>${promptStrengthStatus()}</span></div>
      <div class="field"><label>主角提示词</label><textarea name="playerPrompt" rows="8">${escapeHtml(prompt)}</textarea><span class="small">其中的 &lt;user&gt; 会在发送时替换为主角名。</span></div>
      <button class="btn" type="submit">保存设置</button>
      <button class="btn secondary" type="button" data-action="reset-player-prompt">恢复默认主角提示词</button>
    </form></div>
    <div class="setting-card"><h3>生图设置</h3><p class="small">头像通过“小游戏轻度生图插件”生成，密钥不保存在角色卡或存档中。</p><div class="actions">
      <button class="btn secondary" data-action="open-image-settings">打开生图设置</button>
      <button class="btn secondary" data-action="check-image-status">检测状态</button>
      <button class="btn secondary" data-action="test-image">生成测试图</button>
    </div></div>
    <div class="setting-card"><h3>手动存档</h3>${state.manualSaves.map((slot, index) => `<div class="save-row"><span>槽位 ${index + 1}${slot?.savedAt ? ` · ${escapeHtml(new Date(slot.savedAt).toLocaleString())}` : ' · 空'}</span><button class="btn secondary mini" data-action="manual-save" data-slot="${index}">保存</button><button class="btn ghost mini" data-action="manual-load" data-slot="${index}" ${slot ? '' : 'disabled'}>读取</button></div>`).join('')}</div>
    <div class="setting-card"><h3>交接与导出</h3><p class="small">可将本局人物、履历、地点和主角设定导出为独立世界书，供其他对话使用。</p><button class="btn secondary" data-action="export-worldbook">导出世界书</button></div>
    <p class="small">运行依赖：SillyTavern 1.19.x、酒馆助手 4.9.x。生图插件为可选依赖。</p>
  </section>`;
}

function showModal(title, body, foot, context = null) {
  if (context?.type !== 'avatar-preview') modalReturnFocus = null;
  modalContext = context;
  modalLayer.classList.toggle('story-modal-layer', context?.type === 'story');
  const modalHead = title ? `<header class="modal-head"><h2>${escapeHtml(title)}</h2></header>` : '';
  const accessibleName = title || (context?.type === 'story' ? '剧情' : '对话框');
  modalLayer.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(accessibleName)}">${modalHead}<div class="modal-body">${body}</div><footer class="modal-foot">${foot}</footer></section>`;
  modalLayer.hidden = false;
}

function hideModal() {
  const returnFocus = modalReturnFocus;
  modalLayer.hidden = true;
  modalLayer.classList.remove('story-modal-layer');
  modalLayer.innerHTML = '';
  modalContext = null;
  modalReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function openAvatarPreview(characterId, trigger) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character?.avatarUrl) return;
  modalReturnFocus = trigger;
  showModal(`${character.name}的头像`, `<div class="avatar-preview"><img class="avatar-large" src="${escapeHtml(character.avatarUrl)}" alt="${escapeHtml(character.name)}头像大图"></div>`,
    '<button class="btn secondary" data-action="close-modal">关闭</button>', { type: 'avatar-preview' });
}

function storyHtml(text) {
  return String(text || '').split(/\n\s*\n/).map((paragraph) => {
    let safe = escapeHtml(paragraph).replace(/\n/g, '<br>');
    safe = safe.replace(/\*([^*]+)\*/g, '<span class="thought">$1</span>');
    safe = safe.replace(/“([^”]*)”/g, '<span class="dialogue">“$1”</span>');
    return `<p>${safe}</p>`;
  }).join('');
}

function openStory(chapter, applyPending = false) {
  if (!chapter) return;
  showModal('', `<article class="story">${storyHtml(chapter.displayContent ?? chapter.content)}</article>`,
    `<button class="btn" data-action="close-story">关闭</button>`,
    { type: 'story', chapterId: chapter.id, applyPending });
}

function showError(error) {
  const message = String(error.message || error);
  const versionInfo = message.includes('SillyTavern 版本：') && message.includes('酒馆助手版本：')
    ? ''
    : `<p class="small">SillyTavern 版本：${escapeHtml(runtimeVersions.sillyTavern || '无法读取')}<br>酒馆助手版本：${escapeHtml(runtimeVersions.tavernHelper || '无法读取')}</p>`;
  const modeLabel = state.settings.textPresetMode === 'builtin' ? '使用角色卡自带预设' : '使用当前酒馆预设';
  const recentContextLabel = promptStrengthStatus();
  showModal('剧情生成未完成', `<p>${escapeHtml(message)}</p>${versionInfo}<p class="small">本次事件和数值状态已经保留。重试会继续本次事件；无法解析的旧回复不会被再次用于恢复。</p><p class="small">当前预设模式：${modeLabel}</p><p class="small">${recentContextLabel}</p>`,
    `${promptStrengthButton()}<button class="btn secondary" data-action="switch-preset-mode">切换预设模式</button><button class="btn" data-action="retry-story">重试剧情生成</button>`,
    { type: 'generation-error', message });
}

async function pollJob(jobId, note = '等待生成剧情') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 60 * 1000) {
    loadingNote.textContent = note;
    await new Promise((resolve) => setTimeout(resolve, 850));
    const result = await fetchJson(`/api/ai-jobs/${encodeURIComponent(jobId)}`);
    const job = result.job || {};
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'AI 生成失败。');
  }
  throw new Error('AI 生成等待超过20分钟，请检查酒馆连接后重试。');
}

async function submitAiJob(payload, note) {
  const queued = await fetchJson('/api/generate', { method: 'POST', body: JSON.stringify(payload) });
  return pollJob(queued.job.id, note);
}

function resultText(result) {
  return String(result?.output?.textParts?.join('\n') || result?.raw?.fullText || '');
}

async function applyDisplayRegex(content) {
  try {
    const result = await fetchJson('/api/tavern-display-regex', {
      method: 'POST', body: JSON.stringify({ text: content })
    });
    return typeof result.text === 'string' ? result.text : content;
  } catch {
    return content;
  }
}

async function startStory(request) {
  if (busy || state.pending) return;
  const recoveryId = request.recoveryId || uid('story');
  state.pending = { kind: 'generation', recoveryId, request: { ...request, recoveryId } };
  busy = true;
  try {
    await saveNow();
  } catch (error) {
    setLoading(false);
    render();
    showError(error);
    return;
  }
  await runPendingStory();
}

async function runPendingStory() {
  const pending = state.pending;
  if (pending?.kind !== 'generation') return;
  hideModal();
  setLoading(true, '正在组装剧情提示词');
  try {
    // A previous attempt may have finished after the failure dialog appeared.
    // Consume its durable backup before starting another paid generation.
    if (await recoverPendingGeneration()) return;
    const payload = buildEventPayload(state, pending.request);
    const result = await submitAiJob(payload, '等待生成剧情');
    const text = resultText(result);
    if (!text) throw new Error('AI 返回内容为空。');
    const { parsed, error } = await parsePendingStoryResponse(text, payload, pending);
    if (error) throw error;
    parsed.content = await applyDisplayRegex(parsed.content);
    parsed.displayContent = parsed.content;
    await finishStory(parsed, pending.request, result);
  } catch (error) {
    setLoading(false);
    render();
    showError(error);
  }
}

async function parsePendingStoryResponse(text, payload, pending) {
  try {
    return { parsed: parseEventOutput(text, { requiresCharacter: payload.meta.requiresCharacter }) };
  } catch (error) {
    // Keep the event, but isolate the next attempt from this unusable backup.
    // Persist both IDs before a retry can submit another generation request.
    const recoveryId = uid('story');
    pending.recoveryId = recoveryId;
    pending.request.recoveryId = recoveryId;
    await saveNow();
    return { error };
  }
}

async function finishStory(parsed, request, result = {}) {
  let newCharacter = null;
  if (parsed.character) {
    const isStart = request.type === 'start';
    const gene = isStart ? { combat: 1 } : request.generatedGene;
    newCharacter = {
      id: uid('character'),
      ...normalizeGeneratedCharacter(parsed.character, gene, {
        love: isStart ? 100 : 0,
        health: 100
      })
    };
    state.characters.push(newCharacter);
  }
  if (request.type === 'start') {
    state.introDraft = {
      characterId: newCharacter?.id || '',
      title: parsed.chapter,
      content: parsed.content,
      displayContent: parsed.displayContent,
      history: parsed.history,
      location: parsed.location,
      fullText: String(result?.raw?.fullText || parsed.fullText || ''),
      responseSource: String(result?.raw?.responseSource || 'deferred'),
      helperTextChanged: Boolean(result?.raw?.helperTextChanged),
      recoveryId: String(request.recoveryId || ''),
      createdAt: new Date().toISOString()
    };
    state.phase = 'playing';
    state.currentPage = 'genes';
    state.pending = null;
    try { await saveNow(); } catch { /* error reported by the save controller */ }
    setLoading(false);
    render();
    if (newCharacter && state.settings.imageEnabled) void generateAvatar(newCharacter.id, { silentFailure: true });
    return;
  }
  let characterIds = Array.isArray(request.characterIds) ? [...request.characterIds] : [];
  if (newCharacter) characterIds = [newCharacter.id];
  if (request.type === 'victory') characterIds = state.characters.map((character) => character.id);
  const chapter = {
    id: uid('chapter'), eventType: request.type, title: parsed.chapter,
    content: parsed.content, displayContent: parsed.displayContent,
    history: parsed.history, characterIds, createdAt: new Date().toISOString()
  };
  state.chapters.push(chapter);
  for (const id of characterIds) {
    const character = state.characters.find((item) => item.id === id);
    if (character && !character.storyIds.includes(chapter.id)) character.storyIds.push(chapter.id);
  }
  state.history.push({ id: uid('history'), year: state.year, chapterId: chapter.id, text: `第${state.year}天，${parsed.history}` });
  state.year += 1;
  if (parsed.location) state.locations.push({ id: uid('location'), text: parsed.location, chapterId: chapter.id });

  state.pending = {
    kind: 'effects', chapterId: chapter.id, eventType: request.type,
    characterIds, effect: request.effect || null
  };
  try { await saveNow(); } catch { /* error reported by the save controller */ }
  setLoading(false);
  render();
  openStory(chapter, true);
  if (newCharacter && state.settings.imageEnabled) void generateAvatar(newCharacter.id, { silentFailure: true });
}

async function recoverPendingGeneration() {
  const pending = state.pending;
  if (pending?.kind !== 'generation' || !pending.recoveryId) return false;
  let recovery;
  try {
    recovery = await fetchJson('/api/story-response/recovery', {
      method: 'POST', body: JSON.stringify({ recoveryId: pending.recoveryId })
    });
  } catch {
    return false;
  }
  if (!recovery.found) return false;
  const payload = buildEventPayload(state, pending.request);
  const { parsed, error } = await parsePendingStoryResponse(recovery.fullText, payload, pending);
  if (error) return false;
  parsed.content = await applyDisplayRegex(parsed.content);
  parsed.displayContent = parsed.content;
  await finishStory(parsed, pending.request, {
    raw: { fullText: recovery.fullText, responseSource: 'chat_backup', helperTextChanged: false }
  });
  return true;
}

async function commitPendingEffects() {
  const pending = state.pending;
  if (pending?.kind !== 'effects') return;
  if (pending.eventType === 'gene' || pending.eventType === 'multiGene') {
    for (const characterId of pending.characterIds) applyGeneExtraction(characterId);
  } else if (pending.eventType === 'victory') {
    state.ended = true;
    state.phase = 'ended';
    toast('银河已尽归女皇。本局进入冻结状态。', 'ok');
  }
  state.pending = null;
  render();
  queueSave();
}

function applyGeneExtraction(characterId, tutorial = false) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character || character.live === false) return;
  const effect = tutorial
    ? { healthLoss: 10, lifeEnergy: 1000, fragment: { ...character.gene, combat: 1 } }
    : geneExtractionEffect(character);
  state.genes.push({ id: uid('gene'), sourceCharacterId: character.id, sourceName: character.name, gene: clone(effect.fragment), acquiredAt: new Date().toISOString() });
  state.lifeEnergy += effect.lifeEnergy;
  character.health = Math.max(0, character.health - effect.healthLoss);
  const loveBefore = character.love;
  character.love = Math.min(100, loveBefore + geneExtractionLoveGain());
  const loveGained = character.love - loveBefore;
  toast(`获得 ${formatGene(effect.fragment)} 基因片段`, 'ok');
  if (effect.lifeEnergy > 0) toast(`获得生命能量 ${effect.lifeEnergy}`, 'ok');
  if (loveGained > 0) toast(`${character.name}的爱情度增加 ${loveGained}`, 'ok');
  toast(`${character.name}的健康度减少 ${effect.healthLoss}`, effect.healthLoss ? '' : 'ok');
  if (character.health <= 0) {
    character.live = false;
    state.history.push({ id: uid('history'), year: state.year, text: `第${state.year}天，${character.name}将自己所有的生命能量赠与${state.player.name}后死亡` });
    state.year += 1;
    toast(`${character.name}已死亡。`, 'error');
  }
}

async function completeTutorial() {
  const first = state.characters[0];
  if (!first || state.tutorialComplete) return;
  applyGeneExtraction(first.id, true);
  state.tutorialComplete = true;
  state.pending = null;
  render();
  queueSave();
}

function formatLosses(losses) {
  const lines = losses.filter((item) => item.lost > 0).map((item) => `${item.name} ${item.lost}`);
  return lines.length ? lines.join('，') : '无';
}

async function recruitCharacter() {
  if (busy || state.pending || state.ended || !state.tutorialComplete || state.conquest <= 10) return;
  const generatedGene = createCharacterGene(state.conquest, { scale: 0.8 });
  await startStory({ type: 'reinforcement', generatedGene, effect: { type: 'new-character' } });
}

async function attackSector() {
  if (state.ended || !state.tutorialComplete) return;
  const sector = state.nextSector;
  const strength = calculateArmyStrength(state.troops, sector);
  if (strength.effective < sector.strength) {
    toast('当前兵力不足，再准备一下吧。', 'error');
    return;
  }
  if (!confirm(`确定进攻下一个星域吗？\n我方有效兵力 ${strength.effective}，敌方兵力 ${sector.strength}`)) return;
  const casualties = calculateCasualties(state.troops, sector, strength.effective);
  state.troops = applyCasualties(state.troops, casualties);
  state.conquest = Math.min(100, state.conquest + 1);
  for (const character of state.characters) if (character.live !== false) character.health = 100;
  state.nextSector = createSector(state.conquest);
  toast(`占领了新的星域。损失士兵：${formatLosses(casualties)}`, 'ok');

  if (state.conquest >= 100) {
    toast('宇宙占有度达到100%，正在生成通关剧情。', 'ok');
    await startStory({ type: 'victory', characterIds: state.characters.map((item) => item.id), effect: { type: 'victory' } });
    return;
  }
  if (isFixedConquestEvent(state.conquest)) {
    const generatedGene = createCharacterGene(state.conquest);
    await startStory({ type: 'conquest', generatedGene, effect: { type: 'new-character' } });
    return;
  }
  const mandatory = state.conquest > 10 ? requiredReinforcementGene(state.conquest, state.characters) : null;
  if (mandatory) {
    const generatedGene = createCharacterGene(state.conquest, { mandatory, onlyMandatory: true });
    await startStory({ type: 'reinforcement', generatedGene, effect: { type: 'new-character', mandatory } });
    return;
  }
  if (shouldTriggerReinforcement()) {
    const generatedGene = createCharacterGene(state.conquest);
    await startStory({ type: 'reinforcement', generatedGene, effect: { type: 'new-character' } });
    return;
  }
  state.history.push({ id: uid('history'), year: state.year, text: `第${state.year}天，${state.player.name}占领了一片新的星域，宇宙占有度达到${state.conquest}%` });
  state.year += 1;
  render();
  queueSave();
}

async function revealIntroStory(characterId) {
  const draft = state.introDraft;
  if (!draft || draft.characterId !== characterId) return false;
  setLoading(true, '正在揭示最初的剧情');
  try {
    await fetchJson('/api/story-response/publish', {
      method: 'POST',
      body: JSON.stringify({
        fullText: draft.fullText,
        recoveryId: draft.recoveryId,
        responseSource: draft.responseSource,
        helperTextChanged: draft.helperTextChanged
      })
    });
    const chapter = {
      id: uid('chapter'), eventType: 'start', title: draft.title,
      content: draft.content, displayContent: draft.displayContent,
      history: draft.history, characterIds: [characterId],
      createdAt: draft.createdAt || new Date().toISOString()
    };
    state.chapters.push(chapter);
    const character = state.characters.find((item) => item.id === characterId);
    if (character && !character.storyIds.includes(chapter.id)) character.storyIds.push(chapter.id);
    state.history.push({ id: uid('history'), year: state.year, chapterId: chapter.id, text: `第${state.year}天，${draft.history}` });
    state.year += 1;
    if (draft.location) state.locations.push({ id: uid('location'), text: draft.location, chapterId: chapter.id });
    state.introChapterId = chapter.id;
    state.introDraft = null;
    state.pending = {
      kind: 'effects', chapterId: chapter.id, eventType: 'start',
      characterIds: [characterId], effect: { type: 'tutorial-gene-extraction' }
    };
    try { await saveNow(); } catch { /* error reported by the save controller */ }
    setLoading(false);
    render();
    openStory(chapter, true);
    return true;
  } catch (error) {
    setLoading(false);
    render();
    toast(`最初剧情暂时无法显示：${error.message}`, 'error');
    return false;
  }
}

async function requestGeneExtraction(characterId) {
  const selected = state.characters.find((item) => item.id === characterId);
  if (!selected || selected.live === false || state.ended) return;
  if (!state.tutorialComplete) {
    if (await revealIntroStory(selected.id)) return;
    const legacyChapter = state.chapters.find((item) => item.id === state.introChapterId);
    if (legacyChapter) openStory(legacyChapter, true);
    return;
  }
  if (!confirm(`确定要获取${selected.name}的基因吗？`)) return;
  const others = eligibleMultiGenePartners(state.characters, selected.id);
  const multi = others.length > 0 && shouldTriggerMultiGene();
  const characterIds = multi
    ? [selected.id, others[Math.floor(Math.random() * others.length)].id]
    : [selected.id];
  await startStory({ type: multi ? 'multiGene' : 'gene', characterIds, effect: { type: 'gene-extraction' } });
}

async function giveEnergy(characterId) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character || character.live === false || state.ended || state.lifeEnergy < 1000) return;
  if (!confirm(`消耗1000点生命能量，赋予${character.name}生命能量吗？`)) return;
  state.lifeEnergy -= 1000;
  character.health = Math.min(100, character.health + 10);
  character.love = Math.min(100, character.love + 5);
  state.history.push({ id: uid('history'), year: state.year, text: `第${state.year}天，${state.player.name}将生命能量赋予了${character.name}` });
  state.year += 1;
  render();
  toast(`${character.name}的健康度+10，爱情度+5`, 'ok');
  queueSave();
}

function showCharacterHistory(characterId) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character) return;
  const chapters = character.storyIds.map((id) => state.chapters.find((item) => item.id === id)).filter(Boolean);
  showModal(`${character.name}的过往剧情`, `<div class="history-list">${chapters.map((chapter) => `<button class="history-link" data-action="open-history-chapter" data-id="${chapter.id}">${escapeHtml(chapter.title)}</button>`).join('') || '<div class="empty">暂无剧情</div>'}</div>`,
    '<button class="btn secondary" data-action="close-modal">关闭</button>', { type: 'history-list', characterId });
}

function showArmy() {
  const body = state.troops.length ? state.troops.map((troop) => `<div class="setting-card"><strong>${escapeHtml(troop.name)}</strong><p class="detail">人数 ${troop.count}</p><div class="gene-grid">${GENE_FIELDS.filter((field) => troop.gene[field] > 0).map((field) => `<span class="chip">${GENE_LABELS[field]} ${troop.gene[field]}</span>`).join('')}</div></div>`).join('') : '<div class="empty">尚未生成士兵。</div>';
  showModal(`虫群兵力 ${totalCombatPower(state.troops)}`, body, '<button class="btn secondary" data-action="close-modal">关闭</button>');
}

function showGenePicker(slotIndex, filter = 'all') {
  const selectedElsewhere = new Set(state.templateSlots.filter((_, index) => index !== slotIndex));
  const genes = state.genes.filter((fragment) => {
    if (selectedElsewhere.has(fragment.id)) return false;
    return filter === 'all' || Number(fragment.gene?.[filter] || 0) > 0;
  });
  const filters = [['all', '全部'], ...GENE_FIELDS.slice(1).map((field) => [field, GENE_LABELS[field]])];
  const body = `<div class="field"><label>按抗性筛选</label><select data-action="gene-filter" data-slot="${slotIndex}">${filters.map(([value, label]) => `<option value="${value}" ${filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="history-list">${genes.map((fragment) => `<button class="history-link" data-action="choose-gene" data-id="${fragment.id}" data-slot="${slotIndex}"><strong>${escapeHtml(fragment.sourceName)}</strong><br><span class="small">${escapeHtml(formatGene(fragment.gene))}</span></button>`).join('') || '<div class="empty">没有符合条件的基因片段。</div>'}</div>`;
  showModal(`选择槽位 ${slotIndex + 1} 的基因`, body, '<button class="btn secondary" data-action="close-modal">取消</button>', { type: 'gene-picker', slotIndex, filter });
}

async function createSoldiers() {
  if (state.ended) return;
  const count = clampInt(state.soldierCount, 0, state.lifeEnergy);
  const fragments = state.templateSlots.map((id) => state.genes.find((item) => item.id === id)).filter(Boolean);
  if (count < 1 || !fragments.length) return;
  if (!confirm(`消耗${count}点生命能量和${fragments.length}个基因片段，生成${count}名士兵吗？`)) return;
  const sources = [...new Set(fragments.map((item) => item.sourceName))];
  const candidate = {
    id: uid('troop'), name: `第${state.troops.length + 1}基因虫群`, count,
    gene: sumGenes(fragments), sources, createdAt: new Date().toISOString()
  };
  const troopResult = addOrMergeTroop(state.troops, candidate);
  state.troops = troopResult.troops;
  state.lifeEnergy -= count;
  const consumed = new Set(fragments.map((item) => item.id));
  state.genes = state.genes.filter((item) => !consumed.has(item.id));
  state.templateSlots = state.templateSlots.map(() => null);
  state.soldierCount = 0;
  render();
  toast(troopResult.merged
    ? `${count}名士兵已并入${troopResult.troop.name}。`
    : `生成${count}名${troopResult.troop.name}。`, 'ok');
  queueSave();
}

async function addTemplateSlot() {
  if (state.ended || state.lifeEnergy < 10000) return;
  if (!confirm('是否消耗10000点生命能量增加一个槽位？')) return;
  state.lifeEnergy -= 10000;
  state.templateSlots.push(null);
  render();
  queueSave();
}

async function generateAvatar(characterId, options = {}) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character || state.ended) return;
  if (avatarJobs.has(characterId)) return;
  avatarJobs.add(characterId);
  if (!options.silentFailure) toast('正在后台重新生成头像');
  render();
  try {
    const result = await submitAiJob({
      prompt: buildAvatarPrompt(character),
      modelId: 'gemini-3.1-flash-image',
      options: { responseModalities: 'IMAGE' }
    }, '正在生成角色头像');
    const image = result?.output?.imageParts?.[0];
    if (!image?.data) throw new Error('生图插件没有返回头像数据。');
    const uploaded = await fetchJson('/api/card-images/upload', {
      method: 'POST',
      body: JSON.stringify({ data: image.data, mimeType: image.mimeType || 'image/png', fileName: `${character.id}-avatar` })
    });
    character.avatarUrl = withCacheBust(uploaded.url || uploaded.path);
    // Display the uploaded image immediately. Tavern metadata persistence can
    // be noticeably slower and must not hold the visible avatar refresh back.
    render();
    toast(`${character.name}的头像已更新。`, 'ok');
    queueSave();
  } catch (error) {
    if (!options.silentFailure) toast(error.message, 'error');
  } finally {
    avatarJobs.delete(characterId);
    render();
  }
}

function uploadAvatar(characterId) {
  const character = state.characters.find((item) => item.id === characterId);
  if (!character) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      setLoading(true, '正在保存上传的头像');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const uploaded = await fetchJson('/api/card-images/upload', { method: 'POST', body: JSON.stringify({ data: dataUrl, mimeType: file.type, fileName: `${character.id}-avatar` }) });
      character.avatarUrl = withCacheBust(uploaded.url || uploaded.path);
      render(); toast('头像上传成功。', 'ok'); queueSave();
    } catch (error) { toast(error.message, 'error'); }
    finally { setLoading(false); }
  }, { once: true });
  input.click();
}

async function manualSave(index) {
  try {
    // Capture synchronously before another click can mutate the runtime.
    state.manualSaves[index] = {
      savedAt: new Date().toISOString(),
      snapshot: createManualSaveSnapshot(state)
    };
    render();
    await saveNow();
    toast(`已保存到槽位 ${index + 1}。`, 'ok');
  } catch (error) {
    toast(`保存槽位 ${index + 1} 失败：${error.message}`, 'error');
  }
}

async function manualLoad(index) {
  const slot = state.manualSaves[index];
  if (!slot || !confirm(`读取槽位 ${index + 1}？当前进度会被覆盖。`)) return;
  busy = true;
  try {
    const slots = state.manualSaves;
    const decoded = await decodeManualSaveSnapshot(slot.snapshot);
    const resolved = await fetchJson('/api/card-storage/resolve', {
      method: 'POST', body: JSON.stringify({ data: decoded })
    });
    state = patchState(resolved.data);
    state.manualSaves = slots;
    render();
    await saveNow();
    toast(`已读取槽位 ${index + 1}。`, 'ok');
  } catch (error) {
    toast(`读取槽位 ${index + 1} 失败：${error.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function exportWorldbook() {
  try {
    const result = await fetchJson('/api/export-worldbook', {
      method: 'POST',
      body: JSON.stringify({ runtime: state, promptSettings: { worldBuilding: WORLD_BUILDING, playerSettings: state.player.prompt || defaultPlayerPrompt(state.player) } })
    });
    toast(`世界书“${result.worldbookName}”已导出。`, 'ok');
  } catch (error) { toast(error.message, 'error'); }
}

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const data = new FormData(form);
  if (form.dataset.form === 'player-setup') {
    state.player.name = String(data.get('name') || '').trim();
    state.player.appearance = String(data.get('appearance') || '').trim();
    state.player.personality = String(data.get('personality') || '').trim();
    if (!state.player.name || !state.player.appearance || !state.player.personality) return;
    state.player.prompt = defaultPlayerPrompt(state.player);
    state.phase = 'intro';
    render();
    queueSave();
  } else if (form.dataset.form === 'prompt-settings') {
    state.settings.textPresetMode = data.get('textPresetMode') === 'builtin' ? 'builtin' : 'tavern';
    state.player.prompt = String(data.get('playerPrompt') || '').trim() || defaultPlayerPrompt(state.player);
    render(); toast('文字生成设置已保存。', 'ok'); queueSave();
  }
});

app.addEventListener('input', (event) => {
  const action = event.target.dataset.action;
  if (!['soldier-range', 'soldier-number'].includes(action)) return;
  state.soldierCount = clampInt(event.target.value, 0, state.lifeEnergy);
  const range = app.querySelector('[data-action="soldier-range"]');
  const number = app.querySelector('[data-action="soldier-number"]');
  if (range) range.value = state.soldierCount;
  if (number) number.value = state.soldierCount;
  const createButton = app.querySelector('[data-action="create-soldiers"]');
  if (createButton) createButton.disabled = !canCreateSoldiers(state);
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (action === 'start-game') {
    if (state.phase !== 'intro' || !state.player.name || state.pending) return;
    button.disabled = true;
    state.history.push({ id: uid('history'), year: state.year, text: `第${state.year}天，${state.player.name}作为新生的虫族女皇，在破碎的旧帝国边缘重新开始了自己帝国的构建。` });
    state.year += 1;
    await startStory({ type: 'start' });
  }
  else if (action === 'setup-switch-preset-mode') {
    state.settings.textPresetMode = state.settings.textPresetMode === 'builtin' ? 'tavern' : 'builtin';
    const modeLabel = state.settings.textPresetMode === 'builtin' ? '使用角色卡自带预设' : '使用当前酒馆预设';
    button.textContent = `当前：${modeLabel}（点击切换）`;
    toast(`已切换为“${modeLabel}”。`, 'ok');
    queueSave();
  }
  else if (action === 'navigate') { state.currentPage = button.dataset.page; render(); }
  else if (action === 'show-army') showArmy();
  else if (action === 'attack') await attackSector();
  else if (action === 'recruit') await recruitCharacter();
  else if (action === 'extract-gene') await requestGeneExtraction(button.dataset.id);
  else if (action === 'give-energy') await giveEnergy(button.dataset.id);
  else if (action === 'show-history') showCharacterHistory(button.dataset.id);
  else if (action === 'view-avatar') openAvatarPreview(button.dataset.id, button);
  else if (action === 'generate-avatar') void generateAvatar(button.dataset.id);
  else if (action === 'upload-avatar') uploadAvatar(button.dataset.id);
  else if (action === 'export-avatar-prompt') {
    const character = state.characters.find((item) => item.id === button.dataset.id);
    if (character) {
      try {
        await copyTextToClipboard(buildExportedAvatarPrompt(character));
        toast('提示词已复制到剪贴板', 'ok');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  }
  else if (action === 'pick-gene') showGenePicker(Number(button.dataset.slot));
  else if (action === 'clear-slot') { state.templateSlots[Number(button.dataset.slot)] = null; render(); queueSave(); }
  else if (action === 'add-slot') await addTemplateSlot();
  else if (action === 'create-soldiers') await createSoldiers();
  else if (action === 'toggle-prompt-strength') togglePromptStrength();
  else if (action === 'reset-player-prompt') { state.player.prompt = defaultPlayerPrompt(state.player); render(); queueSave(); }
  else if (action === 'open-image-settings') await fetchJson('/api/image-setup', { method: 'POST', body: '{}' }).catch((error) => toast(error.message, 'error'));
  else if (action === 'check-image-status') {
    try { const status = await fetchJson('/api/image-status'); toast(status.message || (status.ready ? '生图插件已就绪。' : '生图插件尚未就绪。'), status.ready ? 'ok' : 'error'); }
    catch (error) { toast(error.message, 'error'); }
  }
  else if (action === 'test-image') {
    try { setLoading(true, '正在生成测试图'); const status = await fetchJson('/api/image-test', { method: 'POST', body: '{}' }); toast(status.message || '测试生图成功。', 'ok'); }
    catch (error) { toast(error.message, 'error'); }
    finally { setLoading(false); }
  }
  else if (action === 'manual-save') await manualSave(Number(button.dataset.slot));
  else if (action === 'manual-load') await manualLoad(Number(button.dataset.slot));
  else if (action === 'export-worldbook') await exportWorldbook();
});

modalLayer.addEventListener('change', (event) => {
  if (event.target.dataset.action === 'gene-filter') showGenePicker(Number(event.target.dataset.slot), event.target.value);
});

modalLayer.addEventListener('click', async (event) => {
  if (event.target === modalLayer && modalContext?.type === 'avatar-preview') {
    hideModal();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (action === 'close-modal') hideModal();
  else if (action === 'close-story') {
    const shouldApply = Boolean(modalContext?.applyPending);
    const chapterId = modalContext?.chapterId;
    hideModal();
    if (shouldApply && !state.tutorialComplete && chapterId === state.introChapterId) await completeTutorial();
    else if (shouldApply) await commitPendingEffects();
  } else if (action === 'toggle-prompt-strength') {
    if (modalContext?.type !== 'generation-error') return;
    togglePromptStrength();
    showError(new Error(modalContext.message));
  } else if (action === 'switch-preset-mode') {
    const message = modalContext?.message || '剧情生成未完成。';
    state.settings.textPresetMode = state.settings.textPresetMode === 'builtin' ? 'tavern' : 'builtin';
    const modeLabel = state.settings.textPresetMode === 'builtin' ? '使用角色卡自带预设' : '使用当前酒馆预设';
    showError(new Error(message));
    toast(`已切换为“${modeLabel}”。`, 'ok');
    queueSave();
  } else if (action === 'retry-story') {
    busy = true;
    try {
      await saveNow();
    } catch (error) {
      setLoading(false);
      render();
      showError(error);
      return;
    }
    if (state.pending?.kind !== 'generation') {
      setLoading(false);
      return;
    }
    await runPendingStory();
  }
  else if (action === 'open-history-chapter') {
    const chapter = state.chapters.find((item) => item.id === button.dataset.id);
    openStory(chapter, false);
  } else if (action === 'choose-gene') {
    state.templateSlots[Number(button.dataset.slot)] = button.dataset.id;
    hideModal(); render(); queueSave();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalContext?.type === 'avatar-preview') hideModal();
});

window.addEventListener('pagehide', () => saves.syncNow());
window.addEventListener('online', () => saves.syncNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' || document.visibilityState === 'visible') saves.syncNow();
});

async function init() {
  setLoading(true, '正在读取当前对话存档');
  try {
    const bootstrap = await fetchJson('/api/game/bootstrap');
    runtimeVersions = bootstrap.runtimeVersions || {};
    const profile = bootstrap.playerProfile || {};
    chatId = String(bootstrap.chatId || '');
    if (!chatId) throw new Error('无法识别当前对话，请重新打开角色聊天。');
    const [localResult, remoteResult] = await Promise.allSettled([
      localStore.load(chatId), fetchJson('/api/card-storage/chat')
    ]);
    const localStored = localResult.status === 'fulfilled' ? localResult.value : null;
    const remote = remoteResult.status === 'fulfilled' ? remoteResult.value : null;
    if (remote && remote.chatId !== chatId) throw new Error('读取期间对话已切换，请重新打开游戏。');
    if (localResult.status === 'rejected') toast(`本机存档读取失败：${localResult.reason.message}`, 'error');
    if (remoteResult.status === 'rejected') toast(`酒馆存档读取失败：${remoteResult.reason.message}`, 'error');
    if (!localStored && !remote?.data && (remoteResult.status === 'rejected' || localResult.status === 'rejected')) {
      throw new Error('无法读取已有进度，已停止初始化以免覆盖存档。');
    }
    const stored = newerStoredState(remote?.data, localStored);
    const resolved = stored ? await fetchJson('/api/card-storage/resolve', {
      method: 'POST', body: JSON.stringify({ data: stored })
    }) : { data: null };
    state = patchState(resolved.data, profile);
    if (stored) {
      // Reconcile a local commit left behind by a reload during remote syncing.
      void saves.save({ chatId, data: normalizePortableImageUrls(stored) }).catch(() => {});
    }
    setLoading(false);
    render();
    if (remote?.incompatible && !localStored) {
      toast('存档结构已升级为 V3，本开发版本需要重新开始。', 'error');
    }
    if (state.pending?.kind === 'generation') {
      const recovered = await recoverPendingGeneration();
      if (!recovered) showError(new Error('检测到上次未完成的剧情生成。请确认酒馆连接后重试。'));
    } else if (state.pending?.kind === 'effects') {
      const chapter = state.chapters.find((item) => item.id === state.pending.chapterId);
      if (chapter) openStory(chapter, true);
    }
  } catch (error) {
    setLoading(false);
    busy = true;
    app.innerHTML = shell(`<div class="empty">${escapeHtml(error.message)}<br>请重新打开游戏后重试。</div>`);
  }
}

void init();
