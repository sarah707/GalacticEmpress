import { makeGenerationId, sanitizeAiText } from './text.js?build=20261002163531';
import { buildExportWorldbook } from './worldbook.js?build=20261002163531';
import { BUILTIN_PRESET_SETTINGS, cloneBuiltInRequestPreset } from './builtin-preset.js?build=20261002163531';
import {
  decodeStorageValue,
  encodeStorageValue,
  isStorageEnvelope
} from '../storage-codec.js?build=20261002163531';

export const BRIDGE_KEY = '__GALACTIC_EMPRESS_TAVERN_BRIDGE_V1__';
export const CHAT_STORAGE_VARIABLE = '$galacticEmpressGameStorage';

function getMiniGameImageApi(hostWindow, apiWindow) {
  for (const candidateWindow of collectAccessibleWindows(hostWindow, apiWindow)) {
    if (candidateWindow?.STMiniGameImage) return candidateWindow.STMiniGameImage;
  }
  return null;
}

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

function isTextGenerationEndpoint(input, baseUrl = '') {
  const raw = typeof input === 'string' ? input : input?.url || input?.href || '';
  try {
    const path = new URL(raw, baseUrl || 'http://localhost/').pathname.replace(/\/{2,}/g, '/');
    return path === '/api/backends/chat-completions/generate'
      || path === '/api/backends/text-completions/generate'
      || path === '/api/backends/kobold/generate'
      || path === '/api/novelai/generate';
  } catch {
    return /\/api\/(?:backends\/[^/]+\/|novelai\/)generate(?:[?#]|$)/.test(String(raw));
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)([^"',}\s]+)/gi, '$1[已隐藏]');
}

function readGenerationRequestMetadata(input, init) {
  const rawBody = init?.body ?? (typeof input === 'object' ? input?.body : null);
  if (typeof rawBody !== 'string') return {};
  const body = parseJsonObject(rawBody);
  if (!body) return {};
  return {
    source: String(body.chat_completion_source || body.api_type || '').trim(),
    model: String(body.model || '').trim()
  };
}

function extractGenerationResponseText(body) {
  if (typeof body === 'string') return body;
  // Claude may retain thinking before text in its native content array while
  // ST's compatibility choices[0].message.content is empty (first block only).
  if (Array.isArray(body?.content)) {
    const parts = body.content.filter((part) => part?.type === 'text' && typeof part.text === 'string');
    if (parts.length) return parts.map((part) => part.text).join('\n\n');
  }
  const content = body?.choices?.[0]?.message?.content
    ?? body?.choices?.[0]?.text
    ?? body?.text
    ?? body?.message?.content
    ?? body?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter((part) => part?.type === 'text' && typeof part.text === 'string');
    if (parts.length) return parts.map((part) => part.text).join('');
  }
  return null;
}

function isOwnNonStreamingRequest(input, init, eventPrompt) {
  const rawBody = init?.body ?? input?.body;
  if (typeof rawBody !== 'string') return false;
  const body = parseJsonObject(rawBody);
  if (!body || body.stream === true || !Array.isArray(body.messages)) return false;
  const lastUser = body.messages.findLast((message) => message?.role === 'user');
  return formatFinalPromptContent(lastUser?.content) === eventPrompt;
}

function createGenerationErrorCapture(hostWindow, apiWindow, eventPrompt) {
  const patches = [];
  let captured = null;
  let rawResponseText = null;
  for (const candidateWindow of collectAccessibleWindows(hostWindow, apiWindow)) {
    let originalFetch;
    try {
      originalFetch = candidateWindow?.fetch;
    } catch {
      continue;
    }
    if (typeof originalFetch !== 'function') continue;
    const wrappedFetch = async function (...args) {
      const [input, init] = args;
      if (!isTextGenerationEndpoint(input, candidateWindow?.location?.href)) {
        return originalFetch.apply(this, args);
      }
      const startedAt = Date.now();
      const rawUrl = typeof input === 'string' ? input : input?.url || input?.href || '';
      let endpoint;
      try {
        endpoint = new URL(rawUrl, candidateWindow?.location?.href || 'http://localhost/').pathname;
      } catch {
        endpoint = String(rawUrl).split(/[?#]/)[0];
      }
      const request = {
        endpoint,
        ...readGenerationRequestMetadata(input, init)
      };
      const isOwnRequest = isOwnNonStreamingRequest(input, init, eventPrompt);
      captured = request;
      let response;
      try {
        response = await originalFetch.apply(this, args);
      } catch (error) {
        captured = { ...request, elapsedMs: Date.now() - startedAt, transportError: String(error?.message || error) };
        throw error;
      }
      captured = {
        ...request,
        elapsedMs: Date.now() - startedAt,
        httpStatus: Number(response?.status || 0),
        httpStatusText: String(response?.statusText || '').trim()
      };
      if (!response?.ok) {
        let responseText = '';
        try {
          responseText = await response.clone().text();
        } catch {
          // Preserve the original response even when this browser cannot clone it.
        }
        captured = {
          ...captured,
          responseText: redactDiagnosticText(responseText).slice(0, 6000),
          responseBody: parseJsonObject(responseText)
        };
      } else if (isOwnRequest && !String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) {
        // Clone before handing the response to TavernHelper: generation-end hooks can
        // replace its returned message. Never use an unrelated request as our raw text.
        try {
          const body = await response.clone().json();
          rawResponseText = extractGenerationResponseText(body);
        } catch {
          // Unsupported transports still use the helper result, explicitly marked below.
        }
      }
      return response;
    };
    try {
      candidateWindow.fetch = wrappedFetch;
      if (candidateWindow.fetch === wrappedFetch) {
        patches.push({ candidateWindow, originalFetch, wrappedFetch });
      }
    } catch {
      // Some embedded browser surfaces expose a read-only fetch property.
    }
  }
  return {
    getError: () => captured,
    getRawResponseText: () => rawResponseText,
    restore() {
      for (const { candidateWindow, originalFetch, wrappedFetch } of patches.reverse()) {
        try {
          if (candidateWindow.fetch === wrappedFetch) candidateWindow.fetch = originalFetch;
        } catch {
          // Leave a fetch replaced by another extension untouched.
        }
      }
    }
  };
}

function enhanceGenerationError(error, captured = {}, context = {}) {
  captured ||= {};
  const body = captured.responseBody;
  const upstream = body?.error && typeof body.error === 'object' ? body.error : body;
  const upstreamCode = upstream?.code ?? body?.code ?? '';
  const upstreamStatus = upstream?.status ?? body?.status ?? '';
  const upstreamMessage = redactDiagnosticText(
    upstream?.message
      || (typeof body?.error === 'string' ? body.error : '')
      || body?.message
      || body?.response
      || ''
  ).trim();
  const httpStatus = captured.httpStatus
    ? `HTTP ${captured.httpStatus}${captured.httpStatusText ? ` ${captured.httpStatusText}` : ''}`
    : (captured.transportError ? '未收到 HTTP 响应' : '未捕获 HTTP 状态');
  const lines = [
    '文字生成请求失败。',
    `失败阶段：${context.stage || '等待酒馆生成结果'}`,
    `酒馆接口：${httpStatus}`
  ];
  if (captured.endpoint) lines.push(`请求路径：${captured.endpoint}`);
  if (context.elapsedMs !== undefined) lines.push(`本次耗时：${(context.elapsedMs / 1000).toFixed(1)} 秒`);
  if (captured.transportError) lines.push('连接在返回 HTTP 响应前失败，浏览器未提供服务端响应正文。');
  if (upstreamCode || upstreamStatus) {
    lines.push(`上游状态：${[upstreamCode, upstreamStatus].filter(Boolean).join(' / ')}`);
  }
  if (upstreamMessage) lines.push(`上游信息：${upstreamMessage}`);
  if (captured.source || captured.model) {
    lines.push(`生成配置：${[captured.source, captured.model].filter(Boolean).join(' / ')}`);
  }
  if (context.textPresetMode) {
    lines.push(`提示词模式：${context.textPresetMode === 'builtin' ? '游戏内置预设' : '酒馆当前预设'}`);
  }
  if (context.generationId) lines.push(`诊断编号：${context.generationId}`);
  const originalMessage = redactDiagnosticText(error?.message || error || '').trim();
  if (originalMessage) lines.push(`原始异常：${originalMessage}`);
  if (captured.responseText) lines.push(`上游原始响应：${captured.responseText}`);
  if (context.rawText !== undefined) {
    lines.push(`AI 已返回 ${context.rawText.length} 字符；当前错误发生在回复返回之后。`);
    lines.push(`回复原文片段：${context.rawText.slice(0, 1500)}`);
  }
  const enhanced = new Error(lines.join('\n'));
  enhanced.name = error?.name || 'GenerationError';
  enhanced.cause = error;
  return enhanced;
}

function collectApiSurfaces(hostWindow, apiWindow) {
  const surfaces = [];
  for (const candidateWindow of collectAccessibleWindows(apiWindow, hostWindow)) {
    for (const surface of [candidateWindow?.TavernHelper, candidateWindow?.SillyTavern, candidateWindow]) {
      if (surface && !surfaces.includes(surface)) surfaces.push(surface);
    }
  }
  return surfaces;
}

function callFirstAvailable(surfaces, methodName, ...args) {
  for (const surface of surfaces) {
    if (typeof surface?.[methodName] !== 'function') continue;
    try {
      const value = surface[methodName](...args);
      if (value && typeof value.then === 'function') continue;
      if (value !== undefined && value !== null && value !== '') return value;
    } catch {
      // Try the same API exposed on the next accessible window/surface.
    }
  }
  return null;
}

function getHostContexts(hostWindow, apiWindow) {
  const contexts = [];
  for (const surface of collectApiSurfaces(hostWindow, apiWindow)) {
    if (typeof surface?.getContext !== 'function') continue;
    try {
      const context = surface.getContext();
      if (context && !contexts.includes(context)) contexts.push(context);
    } catch {
      // Continue searching parent windows.
    }
  }
  return contexts;
}

function getHostContext(hostWindow, apiWindow) {
  return getHostContexts(hostWindow, apiWindow)[0] || null;
}

function readPersonaDomValue(hostWindow, apiWindow, selector) {
  for (const candidateWindow of collectAccessibleWindows(hostWindow, apiWindow)) {
    try {
      const element = candidateWindow?.document?.querySelector?.(selector);
      const value = String(element?.value || element?.textContent || '').trim();
      if (value) return value;
    } catch {
      // Ignore inaccessible or cross-origin parent documents.
    }
  }
  return '';
}

function expandMacro(value, expanders) {
  const source = String(value || '').trim();
  for (const expand of expanders) {
    if (typeof expand !== 'function') continue;
    try {
      const expanded = String(expand(source) || '').trim();
      if (expanded && expanded !== source) return expanded;
    } catch {
      // Try the next supported SillyTavern/TavernHelper macro API.
    }
  }
  return '';
}

function normalizeServerImagePath(value, hostWindow) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw, hostWindow.location?.origin || hostWindow.location?.href);
    if (url.pathname.includes('/user/images/')) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    if (raw.includes('/user/images/')) {
      return raw.slice(raw.indexOf('/user/images/'));
    }
  }
  return raw;
}

function resolveServerImageUrl(value, hostWindow) {
  const raw = String(value || '').trim();
  if (!raw.includes('/user/images/')) return raw;
  const path = raw.slice(raw.indexOf('/user/images/'));
  try {
    return new URL(path, hostWindow.location?.origin || hostWindow.location?.href).href;
  } catch {
    return raw;
  }
}

function mapStoredImageUrls(value, mapper) {
  if (Array.isArray(value)) return value.map((item) => mapStoredImageUrls(item, mapper));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['avatarUrl', 'avatarOriginalUrl', 'imageUrl', 'imageOriginalUrl'].includes(key) && typeof item === 'string') {
      result[key] = mapper(item);
    } else {
      result[key] = mapStoredImageUrls(item, mapper);
    }
  }
  return result;
}

function sanitizeUploadName(value) {
  return String(value || `image-${Date.now()}`)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `image-${Date.now()}`;
}

function buildHistoryUserInstruction(payload) {
  const options = payload?.options || {};
  const parts = [];
  if (options.retryMarker) {
    parts.push(String(options.retryMarker));
  }
  if (options.historySystemInstruction) {
    parts.push(String(options.historySystemInstruction));
  }
  return parts.map((part) => part.trim()).filter(Boolean).join('\n\n');
}

function buildRecentContextAssistantInstructions(payload) {
  const options = payload?.options || {};
  const parts = Array.isArray(options.assistantInstructions)
    ? options.assistantInstructions.map((part) => String(part || '').trim()).filter(Boolean)
    : [];
  // Retain support for payloads created by older callers while all current game
  // story requests use one entry per chapter.
  if (!parts.length && options.assistantInstruction) parts.push(String(options.assistantInstruction).trim());
  if (options.locationInstruction) {
    parts.push(`以下是此前已经确定的地点描述，后续章节可据此保持一致：\n${String(options.locationInstruction)}`);
  }
  return parts.filter(Boolean);
}

function buildPenultimateUserInstruction(payload) {
  const options = payload?.options || {};
  return [options.outputFormatInstruction, options.writingPointsInstruction]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function buildBuiltInPromptMessages(payload) {
  const playerName = String(payload?.options?.playerName || '').trim();
  // Only game-owned names are substituted; never evaluate host/preset macros.
  const expand = (value) => String(value || '')
    .replace(/<user>|\{\{user\}\}/g, (match) => playerName || match)
    .replace(/\{\{char\}\}/g, '女皇的银河');
  const messages = [];
  const add = (role, content) => {
    const text = String(content || '').trim();
    if (text) messages.push({ role, content: text });
  };
  // Do not prepend a separate built-in role summary. The complete game-owned
  // role and writing rules already live in scriptSettingsInstruction.
  add('system', payload?.options?.scriptSettingsInstruction);
  add('user', buildHistoryUserInstruction(payload));
  for (const instruction of buildRecentContextAssistantInstructions(payload)) {
    add('assistant', instruction);
  }
  add('user', buildPenultimateUserInstruction(payload));
  add('user', payload?.prompt);
  return messages;
}

async function buildBuiltInRequest(hostWindow, apiWindow, payload) {
  const context = getHostContexts(hostWindow, apiWindow).find((item) => (
    typeof item?.ChatCompletionService?.presetToGeneratePayload === 'function'
    && typeof item.ChatCompletionService.sendRequest === 'function'
    && typeof item.getChatCompletionModel === 'function'
  ));
  if (!context) {
    throw new Error('当前酒馆缺少独立聊天补全请求接口，无法隔离本地预设使用内置提示词；请更新 SillyTavern。');
  }
  if (context.mainApi && context.mainApi !== 'openai') {
    throw new Error('当前酒馆选择的是文字补全连接，内置预设暂未适配该 API 类型；本次未调用其他连接。聊天补全连接的提供商和模型不受限制。');
  }
  const service = context.ChatCompletionService;
  // ST 1.19.0 custom-request.js: literal preset -> cloned settings -> native
  // provider conversion. Unlike Helper generate/generateRaw this does not scan
  // worldbooks or invoke prompt/regex events. It never mutates player settings.
  const request = await service.presetToGeneratePayload(cloneBuiltInRequestPreset(), {}, {
    model: context.getChatCompletionModel(),
    messages: buildBuiltInPromptMessages(payload)
  });
  // These controls are read from global power-user state by native conversion.
  // Never send them (or extension tool definitions) in this fixed request.
  for (const key of ['stop', 'logprobs', 'top_logprobs', 'logit_bias', 'tools', 'tool_choice']) delete request[key];
  request.user_name = String(payload?.options?.playerName || '').trim() || '<user>';
  request.char_name = '女皇的银河';
  request.group_names = [];
  return { service, request };
}

function buildVisibleTextPrompt(payload, textPresetMode) {
  const options = payload?.options || {};
  const prompt = String(payload?.prompt || '').trim();
  const sections = [];
  const pushSection = (label, content) => {
    const text = String(content || '').trim();
    if (text) sections.push(`===== ${label} =====\n${text}`);
  };

  if (textPresetMode === 'tavern') {
    pushSection('SYSTEM｜当前预设首个启用的世界书槽位之前｜游戏剧本设定', options.scriptSettingsInstruction);
    const assistantInstructions = buildRecentContextAssistantInstructions(payload);
    const historyDepth = assistantInstructions.length ? assistantInstructions.length + 2 : 3;
    pushSection(`USER｜in_chat depth=${historyDepth}｜履历与重试标记`, buildHistoryUserInstruction(payload));
    assistantInstructions.forEach((instruction, index) => {
      pushSection(`ASSISTANT｜in_chat depth=${assistantInstructions.length + 1 - index}｜章节或地点资料`, instruction);
    });
    pushSection('USER｜in_chat depth=1｜输出格式与写作要求', buildPenultimateUserInstruction(payload));
    pushSection('USER｜user_input｜本次事件', prompt);
  } else {
    return formatCapturedFinalPrompt(buildBuiltInPromptMessages(payload));
  }

  return sections.join('\n\n');
}

function formatFinalPromptContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content || '').trim();
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    if (part?.type === 'image_url' || part?.image_url) return '[图片内容]';
    try {
      return JSON.stringify(part, null, 2);
    } catch {
      return String(part || '');
    }
  }).filter(Boolean).join('\n').trim();
}

function formatCapturedFinalPrompt(messages) {
  return messages.map((message, index) => {
    const role = String(message?.role || 'unknown').toUpperCase();
    const content = formatFinalPromptContent(message?.content);
    return `===== FINAL MESSAGE ${index + 1}｜${role} =====\n${content || '[空内容]'}`;
  }).join('\n\n');
}

function removePromptContent(messages, targetContent) {
  const target = String(targetContent || '').trim();
  if (!target) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message?.content === 'string') {
      if (!message.content.includes(target)) continue;
      const remaining = message.content.split(target).join('').trim();
      if (remaining) message.content = remaining;
      else messages.splice(index, 1);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content
      .map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.includes(target)) return part;
        const remaining = part.text.split(target).join('').trim();
        return remaining ? { ...part, text: remaining } : null;
      })
      .filter(Boolean);
    if (message.content.length === 0) messages.splice(index, 1);
  }
}

function appendTextToMessage(message, text) {
  const addition = String(text || '').trim();
  if (!addition || !message) return false;
  if (typeof message.content === 'string') {
    message.content = `${message.content.trimEnd()}\n${addition}`;
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  const lastTextPart = [...message.content].reverse().find((part) => part?.type === 'text' && typeof part.text === 'string');
  if (lastTextPart) lastTextPart.text = `${lastTextPart.text.trimEnd()}\n${addition}`;
  else message.content.push({ type: 'text', text: addition });
  return true;
}

function removeEmptyReorderedPromptWrappers(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message?.content !== 'string') continue;
    let remaining = message.content
      .replace(/<latest_user_input\b[^>]*>\s*<\/latest_user_input>/gi, '')
      .replace(/<previous_round\b[^>]*>\s*<\/previous_round>/gi, '')
      .trim();
    if (/^<\/previous_round>$/i.test(remaining)) {
      const previousMessage = messages[index - 1];
      const previousContent = formatFinalPromptContent(previousMessage?.content);
      if (/<previous_round\b[^>]*>/i.test(previousContent) && !/<\/previous_round>/i.test(previousContent)) {
        appendTextToMessage(previousMessage, '</previous_round>');
      }
      messages.splice(index, 1);
      continue;
    }
    if (!remaining) {
      messages.splice(index, 1);
      continue;
    }
    message.content = remaining;
  }
}

function moveRequiredUserPromptsToEnd(messages, penultimateUserPrompt, eventPrompt) {
  removePromptContent(messages, penultimateUserPrompt);
  removePromptContent(messages, eventPrompt);
  removeEmptyReorderedPromptWrappers(messages);
  const penultimate = String(penultimateUserPrompt || '').trim();
  const event = String(eventPrompt || '').trim();
  if (penultimate) messages.push({ role: 'user', content: penultimate });
  if (event) messages.push({ role: 'user', content: event });
}

function createFinalPromptCapture(hostWindow, apiWindow, options = {}) {
  for (const context of getHostContexts(hostWindow, apiWindow)) {
    const eventSource = context?.eventSource;
    const eventName = context?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY || 'chat_completion_settings_ready';
    if (!eventSource || (typeof eventSource.makeLast !== 'function' && typeof eventSource.on !== 'function')) continue;
    let capturedMessages = null;
    const listener = async (completion) => {
      options.onPromptReady?.();
      if (!Array.isArray(completion?.messages)) return;
      if (options.removeTrailingModelPrompt) {
        const lastMessage = completion.messages.at(-1);
        // Our chapter/location context is an assistant example, not a preset
        // prefill. The required user messages below will always follow it.
        const isRecentContext = options.recentContextAssistantPrompts?.includes(
          formatFinalPromptContent(lastMessage?.content)
        );
        if (lastMessage && !isRecentContext && ['assistant', 'model'].includes(String(lastMessage.role || '').toLowerCase())) {
          completion.messages.pop();
        }
      }
      moveRequiredUserPromptsToEnd(
        completion.messages,
        options.penultimateUserPrompt,
        options.eventPrompt
      );
      capturedMessages = completion.messages.map((message) => ({
        role: message?.role,
        content: message?.content
      }));
      // 酒馆会等待最终提示词事件结束，再发送模型请求。
      await options.onCaptured?.(capturedMessages);
    };
    if (typeof eventSource.makeLast === 'function') {
      eventSource.makeLast(eventName, listener);
    } else {
      eventSource.on(eventName, listener);
    }
    return {
      available: true,
      getMessages: () => capturedMessages,
      stop() {
        if (typeof eventSource.removeListener === 'function') {
          eventSource.removeListener(eventName, listener);
        } else if (typeof eventSource.off === 'function') {
          eventSource.off(eventName, listener);
        }
      }
    };
  }
  return {
    available: false,
    getMessages: () => null,
    stop() {}
  };
}

function wrapPromptForChat(prompt, textPresetMode, capturedFinalPrompt) {
  const source = String(prompt || '').trim();
  let longestBacktickRun = 0;
  for (const match of source.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  const modeLabel = textPresetMode === 'tavern' ? '酒馆当前预设' : '游戏内置预设';
  const note = capturedFinalPrompt
    ? (textPresetMode === 'builtin'
      ? '以下是内置固定提示词经当前模型接口适配后实际提交的消息；未使用本地预设、世界书或额外玩家描述。'
      : '以下内容截取自酒馆提示词查看器使用的最终消息事件，已经过预设宏、变量、世界书、模板和游戏注入处理。')
    : '当前酒馆助手没有暴露最终消息事件；以下仅展示游戏本次提交的提示词。';
  return `【女皇的银河｜本次发送给 AI 的完整提示词】\n模式：${modeLabel}\n${note}\n\n${fence}text\n${source}\n${fence}`;
}

function emptyPromptOverrides() {
  return {
    char_description: '',
    char_personality: '',
    scenario: '',
    dialogue_examples: '',
    chat_history: {
      prompts: [],
      with_depth_entries: true,
      author_note: ''
    }
  };
}

function getChatCompletionSettings(hostWindow, apiWindow) {
  return getHostContexts(hostWindow, apiWindow)
    .map((context) => context?.chatCompletionSettings)
    .find((settings) => settings && typeof settings === 'object') || null;
}


function insertScriptSettingsBeforeWorldbook(hostWindow, apiWindow, content, generationId) {
  if (!content) return { restore() {} };
  const settings = getChatCompletionSettings(hostWindow, apiWindow);
  const prompts = settings?.prompts;
  // SillyTavern's chat-completion PromptManager uses the global dummy character
  // 100001 (openai.js setupChatCompletionPromptManager), not the current card ID.
  const order = settings?.prompt_order?.find((item) => String(item?.character_id) === '100001')?.order;
  if (!Array.isArray(prompts) || !Array.isArray(order)) {
    throw new Error('无法读取酒馆当前预设的世界书槽位顺序，不能定位游戏剧本设定；请更新 SillyTavern。');
  }
  const anchorIndex = order.findIndex((entry) => {
    if (!entry?.enabled || !['worldInfoBefore', 'worldInfoAfter'].includes(entry.identifier)) return false;
    const prompt = prompts.find((item) => item?.identifier === entry.identifier);
    return prompt && (!Array.isArray(prompt.injection_trigger)
      || !prompt.injection_trigger.length || prompt.injection_trigger.includes('normal'));
  });
  if (anchorIndex < 0) {
    throw new Error('当前酒馆预设没有启用的世界书槽位；请启用 World Info (before) 或 World Info (after)，以便在其前方发送游戏剧本设定。');
  }
  const anchor = prompts.find((item) => item?.identifier === order[anchorIndex].identifier);
  if (Number(anchor.injection_position || 0) !== 0) {
    throw new Error('当前世界书槽位使用聊天深度位置，无法在其前方按预设顺序发送游戏剧本设定；请将该槽位设为相对位置。');
  }
  const identifier = `galactic-empress-script-settings-${generationId}`;
  const temporaryPrompt = {
    identifier,
    name: '游戏剧本设定（仅本次请求）',
    role: 'system',
    content,
    // This is a custom prompt, whose model role is still system. Marking it as
    // system_prompt would exclude it from ST's userRelativePrompts collection.
    system_prompt: false,
    marker: false,
    enabled: true,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
    forbid_overrides: true
  };
  const temporaryOrder = { identifier, enabled: true };
  prompts.push(temporaryPrompt);
  order.splice(anchorIndex, 0, temporaryOrder);
  let removeEarlyCleanup = () => {};
  const injection = {
    restore() {
      removeEarlyCleanup();
      // Never restore an entire settings snapshot: a user/extension may have
      // edited other entries while assembling this request. No preset is saved.
      const arrays = new Set([prompts, order, settings.prompts,
        ...(settings.prompt_order || []).map((item) => item?.order)]);
      for (const entries of arrays) {
        if (!Array.isArray(entries)) continue;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index]?.identifier === identifier) entries.splice(index, 1);
        }
      }
    }
  };
  // Clean before the prompt-manager's deferred render reads settings, rather
  // than waiting for slower completion-settings extensions or the model reply.
  for (const context of getHostContexts(hostWindow, apiWindow)) {
    const events = context?.eventSource;
    if (!events || typeof events.removeListener !== 'function') continue;
    const subscribe = events.makeFirst || events.on;
    if (typeof subscribe !== 'function') continue;
    const eventName = context?.eventTypes?.CHAT_COMPLETION_PROMPT_READY || 'chat_completion_prompt_ready';
    const listener = (data) => {
      if (!data?.dryRun) injection.restore();
    };
    try {
      subscribe.call(events, eventName, listener);
      removeEarlyCleanup = () => events.removeListener(eventName, listener);
    } catch (error) {
      injection.restore();
      throw error;
    }
    break;
  }
  return injection;
}

const LAST_USER_MESSAGE_MACRO_PATTERN = /\{\{\s*lastUserMessage\s*\}\}/i;

function suppressLastUserMessagePresetPrompts(hostWindow, apiWindow) {
  const settings = getChatCompletionSettings(hostWindow, apiWindow);
  const rawPrompts = Array.isArray(settings?.prompts) ? settings.prompts : null;
  const surfaces = collectApiSurfaces(hostWindow, apiWindow);
  const preset = callFirstAvailable(surfaces, 'getPreset', 'in_use');
  const presetPrompts = Array.isArray(preset?.prompts) ? preset.prompts : null;
  const detected = (presetPrompts || rawPrompts || []).filter((prompt) => (
    prompt?.enabled !== false
      && LAST_USER_MESSAGE_MACRO_PATTERN.test(String(prompt?.content || ''))
  ));
  if (detected.length === 0) {
    return { restore() {} };
  }
  if (!rawPrompts) {
    throw new Error('检测到酒馆预设含有 {{lastUserMessage}}，但当前酒馆没有开放可在渲染前过滤的预设数据；请更新 SillyTavern。');
  }
  const detectedIds = new Set(detected.map((prompt) => String(prompt?.id || prompt?.identifier || '')).filter(Boolean));
  const targets = rawPrompts.filter((prompt) => (
    LAST_USER_MESSAGE_MACRO_PATTERN.test(String(prompt?.content || ''))
      || detectedIds.has(String(prompt?.id || prompt?.identifier || ''))
  ));
  if (targets.length === 0) {
    throw new Error('检测到酒馆预设含有 {{lastUserMessage}}，但无法定位对应的原始预设条目。');
  }
  const originals = targets.map((prompt) => ({ prompt, content: prompt.content }));
  for (const { prompt } of originals) prompt.content = '';
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      for (const original of originals) original.prompt.content = original.content;
    }
  };
}

function isGeminiChatConnection(hostWindow, apiWindow) {
  const source = String(getChatCompletionSettings(hostWindow, apiWindow)?.chat_completion_source || '').toLowerCase();
  return source === 'makersuite' || source === 'vertexai';
}

function isImagePayload(payload) {
  const modalities = String(payload?.options?.responseModalities || '').toUpperCase();
  return modalities.includes('IMAGE') || /(?:^|[-_])(image|imagen)(?:[-_]|$)/i.test(String(payload?.modelId || ''));
}

function buildImageResultMetadata(generated) {
  const metadata = {};
  const provider = String(generated?.provider || '').trim();
  const model = String(generated?.model || '').trim();
  const usageMetadata = generated?.usageMetadata ?? generated?.raw?.usageMetadata;
  const usage = generated?.usage ?? generated?.raw?.usage;
  if (provider) metadata.provider = provider;
  if (model) metadata.model = model;
  if (usageMetadata && typeof usageMetadata === 'object') metadata.usageMetadata = usageMetadata;
  if (usage && typeof usage === 'object') metadata.usage = usage;
  return metadata;
}

function forceHostChatToBottom(hostWindow) {
  try {
    const chat = hostWindow?.document?.getElementById?.('chat');
    if (!chat) return;
    const scroll = () => { chat.scrollTop = chat.scrollHeight; };
    if (typeof hostWindow?.requestAnimationFrame === 'function') {
      hostWindow.requestAnimationFrame(scroll);
    } else {
      scroll();
    }
  } catch {
    // 聊天滚动只是显示增强，不能影响已经写入的剧情楼层。
  }
}

function hasStoredChatMessageData(hostWindow, apiWindow, marker) {
  const checks = marker?.values && typeof marker.values === 'object'
    ? Object.entries(marker.values)
    : (marker?.key ? [[marker.key, marker.value]] : []);
  if (!checks.length) return false;
  for (const context of getHostContexts(hostWindow, apiWindow)) {
    if (!Array.isArray(context?.chat)) continue;
    if (context.chat.some((item) => {
      const data = getChatMessageData(item);
      return checks.every(([key, value]) => Object.hasOwn(data, key)
        && String(data[key] ?? '') === String(value ?? ''));
    })) return true;
  }
  return false;
}

function waitForPromiseWithTimeout(promise, timeoutMs, message, timerWindow = globalThis) {
  let timerId = null;
  const timerHost = typeof timerWindow?.setTimeout === 'function' ? timerWindow : globalThis;
  const timeout = new Promise((_, reject) => {
    timerId = timerHost.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timerId !== null) timerHost.clearTimeout(timerId);
  });
}

async function appendTextMessageToChat(helper, hostWindow, role, message, data, options = {}) {
  if (typeof helper?.createChatMessages !== 'function') {
    throw new Error('当前酒馆助手缺少 createChatMessages 接口，无法把完整提示词和 AI 回复写入聊天楼层；请更新酒馆助手。');
  }
  const write = Promise.resolve(helper.createChatMessages([{
    role,
    message,
    data,
    extra: { source: 'galactic-empress-tavern-card' }
  }], {
    insert_before: 'end',
    refresh: 'affected'
  }));
  const storedMarker = options.storedMarker;
  if (storedMarker?.key || storedMarker?.values) {
    // Tavern Helper writes context.chat before awaiting MESSAGE_*_RENDERED hooks.
    // Let those hooks finish in the background once the exact prompt is durable
    // in the live chat, so a rendering extension cannot prevent model dispatch.
    await Promise.resolve();
    await Promise.resolve();
    if (hasStoredChatMessageData(hostWindow, options.apiWindow, storedMarker)) {
      void write.catch(() => {});
      if (role === 'assistant') forceHostChatToBottom(hostWindow);
      return;
    }
  }
  await waitForPromiseWithTimeout(
    write,
    Number(options.timeoutMs || 15000),
    options.timeoutMessage || '酒馆聊天楼层写入超时，请检查可能卡住的消息渲染扩展。',
    hostWindow
  );
  if (role === 'assistant') forceHostChatToBottom(hostWindow);
}

function getChatMessageData(message) {
  if (message?.data && typeof message.data === 'object') return message.data;
  const swipeId = Number(message?.swipe_id || 0);
  if (Array.isArray(message?.variables)) return message.variables[swipeId] || message.variables[0] || {};
  return message?.variables && typeof message.variables === 'object' ? message.variables : {};
}

function findStoredStoryResponse(helper, hostWindow, apiWindow, recoveryId, { requireRaw = false } = {}) {
  const targetId = String(recoveryId || '').trim();
  if (!targetId) return null;
  const messageGroups = [];
  for (const context of getHostContexts(hostWindow, apiWindow)) {
    if (Array.isArray(context?.chat)) messageGroups.push(context.chat);
  }
  // Poll the live chat directly when available; cloning every historical floor
  // every two seconds is unnecessary while waiting for one generation's backup.
  if ((!requireRaw || messageGroups.length === 0) && typeof helper?.getChatMessages === 'function') {
    try {
      const messages = helper.getChatMessages('0-{{lastMessageId}}');
      if (Array.isArray(messages)) messageGroups.push(messages);
    } catch {
      // The accessible live chat records remain available below.
    }
  }
  let legacyText = null;
  for (const messages of messageGroups) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const data = getChatMessageData(message);
      if (String(data?.galacticEmpressRecoveryId || '') !== targetId) continue;
      if (data?.galacticEmpressGameResponse !== true && data?.galacticEmpressResponseEmpty !== true) continue;
      if (typeof data.galacticEmpressRawResponse === 'string') return data.galacticEmpressRawResponse;
      if (requireRaw) continue;
      if (data?.galacticEmpressResponseEmpty === true) return '';
      const text = typeof message?.message === 'string' ? message.message : message?.mes;
      if (legacyText === null && typeof text === 'string') legacyText = text;
    }
  }
  return legacyText;
}

async function saveChatMetadataDurably(hostWindow, apiWindow) {
  const candidates = [
    ...getHostContexts(hostWindow, apiWindow),
    ...collectApiSurfaces(hostWindow, apiWindow)
  ];
  for (const candidate of candidates) {
    if (typeof candidate?.saveMetadata !== 'function') continue;
    await candidate.saveMetadata();
    return;
  }
  throw new Error('当前酒馆没有提供立即保存对话变量的接口；为避免刷新后回档，本次存档未标记为成功。请更新 SillyTavern。');
}

export function createTavernBridge({
  hostWindow,
  apiWindow = globalThis,
  buildMode = 'github',
  promptWriteTimeoutMs = 15000
}) {
  const helper = apiWindow.TavernHelper || apiWindow;
  const shouldWritePromptFloor = String(buildMode || '').trim().toLowerCase() === 'github';
  let textRequestActive = false;
  let activeTextRecoveryId = '';
  const getCurrentChatId = () => String(
    hostWindow?.SillyTavern?.getCurrentChatId?.()
      || apiWindow?.SillyTavern?.getCurrentChatId?.()
      || getHostContext(hostWindow, apiWindow)?.chatId
      || helper?.getCurrentChatId?.()
      || ''
  );
  return {
    version: 1,
    getCurrentChatId,
    getTextRequestState() {
      return { active: textRequestActive, recoveryId: activeTextRecoveryId };
    },
    getPlayerProfile() {
      const surfaces = collectApiSurfaces(hostWindow, apiWindow);
      const contexts = getHostContexts(hostWindow, apiWindow);
      const persona = callFirstAvailable(surfaces, 'getPersona', 'current');
      const expanders = [
        ...contexts.map((context) => context?.substituteParams?.bind(context)),
        ...surfaces.map((surface) => surface?.substitudeMacros?.bind(surface))
      ];
      const recentUserName = contexts
        .flatMap((context) => Array.isArray(context?.chat) ? context.chat : [])
        .reverse()
        .find((message) => message?.is_user === true || message?.role === 'user')?.name;
      const name = String(
        persona?.name
        || callFirstAvailable(surfaces, 'getCurrentPersonaName')
        || surfaces.map((surface) => surface?.name1).find(Boolean)
        || contexts.map((context) => context?.name1).find(Boolean)
        || expandMacro('{{user}}', expanders)
        || recentUserName
        || readPersonaDomValue(hostWindow, apiWindow, '#your_name')
        || ''
      ).trim();
      const description = String(
        persona?.description
        || surfaces.map((surface) => surface?.powerUserSettings?.persona_description || surface?.persona_description).find(Boolean)
        || contexts.map((context) => context?.powerUserSettings?.persona_description).find(Boolean)
        || expandMacro('{{persona}}', expanders)
        || readPersonaDomValue(hostWindow, apiWindow, '#persona_description')
        || ''
      ).trim();
      return { name, description };
    },
    formatStoryTextForDisplay(text) {
      const source = String(text || '');
      for (const surface of collectApiSurfaces(hostWindow, apiWindow)) {
        if (typeof surface?.formatAsTavernRegexedString !== 'function') continue;
        try {
          const formatted = surface.formatAsTavernRegexedString(source, 'ai_output', 'display', { depth: 0 });
          return typeof formatted === 'string' ? formatted : source;
        } catch {
          // Keep the extracted story readable if a user regex or helper API fails.
        }
      }
      return source;
    },
    async loadGameStorage() {
      if (typeof helper?.getVariables !== 'function') {
        throw new Error('当前酒馆助手缺少对话变量读取接口，无法读取跨设备存档；请更新并启用酒馆助手。');
      }
      const variables = await helper.getVariables({ type: 'chat' });
      const stored = variables?.[CHAT_STORAGE_VARIABLE];
      if (!stored) return { chatId: getCurrentChatId(), data: null, incompatible: false };
      if (!isStorageEnvelope(stored)) {
        return { chatId: getCurrentChatId(), data: null, incompatible: true };
      }
      const decoded = await decodeStorageValue(stored);
      if (decoded.schemaVersion !== 3 || !decoded.current) {
        return { chatId: getCurrentChatId(), data: null, incompatible: true };
      }
      return {
        chatId: getCurrentChatId(),
        data: mapStoredImageUrls(decoded, (value) => resolveServerImageUrl(value, hostWindow)),
        incompatible: false
      };
    },
    resolveGameStorage(data) {
      return mapStoredImageUrls(data, (value) => resolveServerImageUrl(value, hostWindow));
    },
    async saveGameStorage(data, expectedChatId = '') {
      if (data?.schemaVersion !== 3 || !data.current) throw new Error('只接受 V3 游戏存档。');
      const metadataContext = getHostContexts(hostWindow, apiWindow)
        .find((candidate) => typeof candidate?.updateChatMetadata === 'function');
      if (typeof helper?.getVariables !== 'function'
        || (!metadataContext && typeof helper?.replaceVariables !== 'function')) {
        throw new Error('当前酒馆助手缺少对话变量完整覆盖接口，无法安全保存或回滚存档；请更新并启用酒馆助手。');
      }
      const currentChatId = getCurrentChatId();
      if (expectedChatId && String(expectedChatId) !== currentChatId) {
        throw new Error('当前对话已经切换，已取消上一段对话的延迟存档写入。');
      }
      const stored = data && typeof data === 'object'
        ? mapStoredImageUrls(data, (value) => normalizeServerImagePath(value, hostWindow))
        : null;
      const encoded = await encodeStorageValue(stored);
      // Tavern Helper 4.9.5 (tag af21bee, src/function/variables.ts) implements
      // its partial-update helpers as getVariables + whole-table replacement too.
      // Preserve unrelated chat variables explicitly. SillyTavern 1.19.0 exposes
      // updateChatMetadata, which updates memory without also scheduling Tavern
      // Helper's second delayed metadata save. Keep replaceVariables as a fallback.
      const variables = await helper.getVariables({ type: 'chat' });
      if (getCurrentChatId() !== currentChatId) {
        throw new Error('压缩存档期间对话已切换，已取消写入。');
      }
      const nextVariables = {
        ...(variables && typeof variables === 'object' ? variables : {}),
        [CHAT_STORAGE_VARIABLE]: encoded
      };
      if (metadataContext) {
        await metadataContext.updateChatMetadata({ variables: nextVariables }, false);
      } else {
        await helper.replaceVariables(nextVariables, { type: 'chat' });
      }
      await saveChatMetadataDurably(hostWindow, apiWindow);
      return { ok: true, chatId: currentChatId };
    },
    loadStoryResponse(recoveryId, options) {
      const fullText = findStoredStoryResponse(helper, hostWindow, apiWindow, recoveryId, options);
      return fullText === null
        ? { found: false, fullText: '' }
        : { found: true, fullText };
    },
    async publishStoryResponse({ fullText, recoveryId, responseSource = 'deferred', helperTextChanged = false } = {}) {
      const text = String(fullText || '');
      const recovery = String(recoveryId || '').trim();
      if (!text) throw new Error('待发布的开始剧情原文为空。');
      if (recovery) {
        const existing = findStoredStoryResponse(helper, hostWindow, apiWindow, recovery, { requireRaw: true });
        if (existing !== null) {
          if (existing !== text) throw new Error('同一恢复标识已经对应另一条 AI 回复，已阻止重复写入。');
          return { ok: true, alreadyPublished: true };
        }
      }
      await appendTextMessageToChat(helper, hostWindow, 'assistant', text, {
        galacticEmpressGameResponse: true,
        ...(recovery ? { galacticEmpressRecoveryId: recovery } : {}),
        galacticEmpressRawResponse: text,
        galacticEmpressResponseSource: responseSource,
        galacticEmpressHelperTextChanged: Boolean(helperTextChanged)
      }, recovery ? {
        apiWindow,
        storedMarker: {
          values: {
            galacticEmpressRecoveryId: recovery,
            galacticEmpressRawResponse: text
          }
        },
        timeoutMessage: '酒馆 assistant 楼层写入超时，请检查可能卡住的消息渲染扩展。'
      } : {});
      return { ok: true, alreadyPublished: false };
    },
    async uploadImage({ data, mimeType, fileName } = {}) {
      const base64Data = String(data || '').replace(/^data:[^;,]+;base64,/, '');
      if (!base64Data) throw new Error('待保存的图片数据为空。');
      const normalizedMimeType = String(mimeType || 'image/png').toLowerCase();
      const format = normalizedMimeType.includes('jpeg') || normalizedMimeType.includes('jpg')
        ? 'jpg'
        : normalizedMimeType.includes('webp')
          ? 'webp'
          : 'png';
      const context = getHostContext(hostWindow, apiWindow);
      if (typeof context?.getRequestHeaders !== 'function') {
        throw new Error('当前酒馆没有提供图片上传鉴权接口，请更新 SillyTavern。');
      }
      const endpoint = new URL('/api/images/upload', hostWindow.location?.origin || hostWindow.location?.href).href;
      const response = await hostWindow.fetch(endpoint, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
          image: base64Data,
          format,
          ch_name: 'galactic-empress',
          filename: sanitizeUploadName(fileName)
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.path) {
        throw new Error(result?.error || `图片保存到酒馆失败（HTTP ${response.status}）。`);
      }
      const path = normalizeServerImagePath(result.path, hostWindow);
      return { path, url: resolveServerImageUrl(path, hostWindow) };
    },
    async openImageSetup() {
      const showImageSetup = hostWindow.galacticEmpressOverlay?.showImageSetup;
      if (typeof showImageSetup !== 'function') return false;
      return Boolean(await showImageSetup());
    },
    async getImageGeneratorStatus() {
      const api = getMiniGameImageApi(hostWindow, apiWindow);
      if (!api || typeof api.getStatus !== 'function') {
        return {
          installed: false,
          configured: false,
          ready: false,
          message: '未检测到“小游戏轻度生图插件”。'
        };
      }
      try {
        return await api.getStatus();
      } catch (error) {
        return {
          installed: true,
          configured: false,
          ready: false,
          message: error.message || '生图插件状态检测失败。'
        };
      }
    },
    async testImageGenerator() {
      const api = getMiniGameImageApi(hostWindow, apiWindow);
      if (!api || typeof api.generate !== 'function') {
        throw new Error('未安装“小游戏轻度生图插件”。');
      }
      const generated = await api.generate({
        prompt: 'A single small pale purple circle centered on a plain white background, no text',
        negativePrompt: 'letters, words, watermark, complex background',
        aspectRatio: '1:1',
        imageSize: '1K',
        width: 256,
        height: 256,
        steps: 4,
        saveToSillyTavern: false
      });
      const image = generated?.images?.[0];
      if (!image?.data && !image?.dataUrl) {
        throw new Error('接口没有返回可用的测试图片。');
      }
      const rawImageData = String(image.data || '');
      const imageDataUrl = String(
        image.dataUrl
        || (rawImageData.startsWith('data:')
          ? rawImageData
          : `data:${image.mimeType || 'image/png'};base64,${rawImageData}`)
      );
      return {
        installed: true,
        configured: true,
        ready: true,
        verified: true,
        provider: generated.provider || '',
        model: generated.model || '',
        imageDataUrl,
        message: '测试生图成功，当前配置可以使用。'
      };
    },
    async request(payload) {
      if (isImagePayload(payload)) {
        const api = getMiniGameImageApi(hostWindow, apiWindow);
        if (!api || typeof api.generate !== 'function') {
          throw new Error('未安装“小游戏轻度生图插件”，已跳过本次图片生成。');
        }
        const generated = await api.generate({
          prompt: payload?.prompt,
          aspectRatio: '1:1',
          imageSize: '0.5K',
          saveToSillyTavern: false
        });
        const image = generated?.images?.[0];
        if (!image?.data) throw new Error('生图插件没有返回图片数据。');
        return {
          output: { textParts: [], thoughtParts: [], imageParts: [{ mimeType: image.mimeType, data: image.data }] },
          // Keep only the small fields consumed by the activity UI. Provider
          // responses may repeat the full base64 image inside `generated.raw`.
          raw: buildImageResultMetadata(generated)
        };
      }
      const prompt = String(payload?.prompt || '').trim();
      if (!prompt) throw new Error('文字生成提示词为空。');
      const recoveryId = String(payload?.recoveryId || '').trim();
      if (textRequestActive) {
        const error = new Error('上一条文字生成尚未结束，请等待完成后再发送。');
        error.code = 'TEXT_REQUEST_ACTIVE';
        error.activeRecoveryId = activeTextRecoveryId;
        error.requestedRecoveryId = recoveryId;
        throw error;
      }
      const textPresetMode = payload?.options?.textPresetMode === 'builtin' ? 'builtin' : 'tavern';
      const deferAssistantChatWrite = payload?.options?.deferAssistantChatWrite === true;
      const startedAt = Date.now();
      let stage = '准备生成请求';
      const generationId = makeGenerationId();
      let promptWrite = null;
      const writePrompt = (messages) => {
        if (!shouldWritePromptFloor) {
          promptWrite ||= Promise.resolve();
          return promptWrite;
        }
        if (!promptWrite) {
          const captured = Array.isArray(messages) && messages.length > 0;
          const visiblePrompt = captured
            ? formatCapturedFinalPrompt(messages)
            : buildVisibleTextPrompt(payload, textPresetMode);
          stage = '写入酒馆 user 楼层';
          promptWrite = appendTextMessageToChat(helper, hostWindow, 'user',
            wrapPromptForChat(visiblePrompt, textPresetMode, captured),
            { galacticEmpressGamePrompt: true, galacticEmpressPromptId: generationId }, {
              apiWindow,
              storedMarker: { key: 'galacticEmpressPromptId', value: generationId },
              timeoutMs: promptWriteTimeoutMs,
              timeoutMessage: '酒馆 user 楼层写入超时，模型请求尚未发送；请检查可能卡住的消息渲染扩展。'
            }).then(() => { stage = '等待 AI 回复'; });
        }
        return promptWrite;
      };
      const penultimateUserPrompt = buildPenultimateUserInstruction(payload);
      const presetPromptSuppression = textPresetMode === 'tavern'
        ? suppressLastUserMessagePresetPrompts(hostWindow, apiWindow)
        : { restore() {} };
      let scriptSettingsPresetPrompt = { restore() {} };
      let builtInMessages = null;
      const finalPromptCapture = textPresetMode === 'builtin'
        ? { available: true, getMessages: () => builtInMessages, stop() {} }
        : createFinalPromptCapture(hostWindow, apiWindow, {
        removeTrailingModelPrompt: isGeminiChatConnection(hostWindow, apiWindow),
        recentContextAssistantPrompts: buildRecentContextAssistantInstructions(payload),
        penultimateUserPrompt,
        eventPrompt: prompt,
        onPromptReady: () => {
          scriptSettingsPresetPrompt.restore();
          presetPromptSuppression.restore();
        },
        onCaptured: writePrompt
      });
      if (!finalPromptCapture.available) {
        presetPromptSuppression.restore();
        throw new Error('当前酒馆助手未开放最终提示词事件，无法保证输出格式和事件提示词位于请求末尾；请更新酒馆助手。');
      }
      let text;
      const generationErrorCapture = createGenerationErrorCapture(hostWindow, apiWindow, prompt);
      textRequestActive = true;
      activeTextRecoveryId = recoveryId;
      let generationHooksReleased = false;
      const releaseGenerationHooks = () => {
        if (generationHooksReleased) return;
        generationHooksReleased = true;
        generationErrorCapture.restore();
        scriptSettingsPresetPrompt.restore();
        presetPromptSuppression.restore();
        finalPromptCapture.stop();
      };
      let fullText;
      let responseSource = textPresetMode === 'builtin' ? 'native' : 'helper';
      let helperTextChanged = false;
      try {
        stage = '等待酒馆生成结果';
        if (textPresetMode === 'builtin') {
          const { service, request } = await buildBuiltInRequest(hostWindow, apiWindow, payload);
          builtInMessages = request.messages.map((message) => ({ role: message.role, content: message.content }));
          await writePrompt(builtInMessages);
          text = extractGenerationResponseText(await service.sendRequest(request, false)) ?? '';
        } else {
          if (typeof apiWindow.generate !== 'function') {
            throw new Error('当前酒馆助手缺少 generate 接口，无法使用原生预设拼接；请更新酒馆助手。');
          }
          const scriptSettingsInstruction = String(payload?.options?.scriptSettingsInstruction || '').trim();
          const historyUserInstruction = buildHistoryUserInstruction(payload);
          const recentContextAssistantInstructions = buildRecentContextAssistantInstructions(payload);
          const penultimateUserInstruction = buildPenultimateUserInstruction(payload);
          const historyDepth = recentContextAssistantInstructions.length
            ? recentContextAssistantInstructions.length + 2
            : 3;
          const injects = [];
          if (scriptSettingsInstruction) {
            scriptSettingsPresetPrompt = insertScriptSettingsBeforeWorldbook(
              hostWindow, apiWindow, scriptSettingsInstruction, generationId
            );
            injects.push({
              role: 'system',
              content: scriptSettingsInstruction,
              // Scan-only: the actual message is assembled by the native
              // preset order before its worldbook slot, not by chat depth.
              position: 'none',
              depth: 0,
              should_scan: true
            });
          }
          if (historyUserInstruction) {
            injects.push({
              role: 'user',
              content: historyUserInstruction,
              position: 'in_chat',
              depth: historyDepth,
              should_scan: false
            });
          }
          for (const [index, recentContextAssistantInstruction] of recentContextAssistantInstructions.entries()) {
            injects.push({
              role: 'assistant',
              content: recentContextAssistantInstruction,
              position: 'in_chat',
              depth: recentContextAssistantInstructions.length + 1 - index,
              should_scan: false
            });
          }
          if (penultimateUserInstruction) {
            injects.push({
              role: 'user',
              content: penultimateUserInstruction,
              position: 'in_chat',
              depth: 1,
              should_scan: false
            });
          }
          text = await apiWindow.generate({
            preset_name: 'in_use',
            user_input: prompt,
            should_silence: true,
            should_stream: false,
            max_chat_history: 0,
            injects,
            overrides: emptyPromptOverrides(),
            generation_id: generationId
          });
        }
        // Rendering a chat floor may wait on third-party extensions. The model
        // request is already over, so never keep its global hooks active there.
        releaseGenerationHooks();
        await writePrompt(finalPromptCapture.getMessages());
        const helperText = typeof text === 'string' ? text : String(text?.content || '');
        const networkText = generationErrorCapture.getRawResponseText();
        responseSource = networkText !== null ? 'network' : responseSource;
        fullText = networkText ?? helperText;
        helperTextChanged = networkText !== null && networkText !== helperText;
        if (!deferAssistantChatWrite) {
          stage = '写入酒馆模型楼层（AI 已返回）';
          // 正文可能被其他扩展改写；恢复时优先读取独立备份，不反读展示正文。
          await appendTextMessageToChat(helper, hostWindow, 'assistant',
            fullText || '【女皇的银河｜AI 返回内容为空】',
            {
              ...(fullText ? { galacticEmpressGameResponse: true } : { galacticEmpressGameError: true, galacticEmpressResponseEmpty: true }),
              ...(recoveryId ? { galacticEmpressRecoveryId: recoveryId } : {}),
              galacticEmpressRawResponse: fullText,
              galacticEmpressResponseSource: responseSource,
              galacticEmpressHelperTextChanged: helperTextChanged
            }, recoveryId ? {
              apiWindow,
              storedMarker: {
                values: {
                  galacticEmpressRecoveryId: recoveryId,
                  galacticEmpressRawResponse: fullText
                }
              },
              timeoutMessage: '酒馆 assistant 楼层写入超时，请检查可能卡住的消息渲染扩展。'
            } : {});
        }
      } catch (error) {
        // A rendering callback can fail after the raw reply was inserted. Keep
        // that successful reply instead of adding a misleading failure floor.
        const storedReply = !deferAssistantChatWrite && typeof fullText === 'string' && recoveryId
          ? findStoredStoryResponse(helper, hostWindow, apiWindow, recoveryId, { requireRaw: true })
          : null;
        if (storedReply === null || storedReply !== fullText) {
          const diagnostic = enhanceGenerationError(error, generationErrorCapture.getError(), {
            generationId,
            textPresetMode,
            stage,
            elapsedMs: Date.now() - startedAt,
            rawText: fullText
          });
          // 网络断开时写聊天也可能失败或久等，不能让它遮住最初的诊断。
          void writePrompt(finalPromptCapture.getMessages()).then(() => (
            appendTextMessageToChat(helper, hostWindow, 'assistant',
              `【女皇的银河｜AI 请求失败】\n${redactDiagnosticText(diagnostic.message)}`,
              { galacticEmpressGameError: true })
          )).catch(() => {});
          throw diagnostic;
        }
      } finally {
        releaseGenerationHooks();
        textRequestActive = false;
        activeTextRecoveryId = '';
      }
      return {
        output: { textParts: [sanitizeAiText(fullText)], thoughtParts: [], imageParts: [] },
        raw: { fullText, responseSource, helperTextChanged }
      };
    },
    async exportWorldbook(runtime, promptSettings) {
      if (typeof helper.createOrReplaceWorldbook !== 'function') {
        throw new Error('当前酒馆助手没有提供世界书写入 API，请更新酒馆助手。');
      }
      const { worldbookName, entries } = buildExportWorldbook(runtime, promptSettings);
      const created = await helper.createOrReplaceWorldbook(worldbookName, entries, { render: 'immediate' });
      return { worldbookName, created };
    }
  };
}
