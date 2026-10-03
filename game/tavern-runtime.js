(() => {
  'use strict';

  const BRIDGE_KEY = '__GALACTIC_EMPRESS_TAVERN_BRIDGE_V1__';
  const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
  const originalFetch = window.fetch.bind(window);
  const jobs = new Map();

  function clearTerminalJobExpiry(job) {
    const expiry = job?.expiry;
    if (!expiry) return;
    job.expiry = null;
    try {
      expiry.host.clearTimeout(expiry.id);
    } catch {
      // The terminal job is still safe to consume if its timer host disappeared.
    }
  }

  function deleteJob(job) {
    if (!job || jobs.get(job.id) !== job) return false;
    clearTerminalJobExpiry(job);
    return jobs.delete(job.id);
  }

  function scheduleTerminalJobExpiry(job) {
    if (!job || !['completed', 'failed'].includes(job.status) || job.expiry) return;
    const timerHost = typeof window.setTimeout === 'function' && typeof window.clearTimeout === 'function'
      ? window
      : null;
    if (!timerHost) return;
    const id = timerHost.setTimeout(() => {
      if (jobs.get(job.id) === job && ['completed', 'failed'].includes(job.status)) {
        jobs.delete(job.id);
      }
      job.expiry = null;
    }, TERMINAL_JOB_TTL_MS);
    job.expiry = { host: timerHost, id };
  }

  function bridge() {
    const value = window.parent?.[BRIDGE_KEY];
    if (!value?.request) throw new Error('酒馆桥接尚未就绪，请关闭浮窗后重新打开。');
    return value;
  }

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function normalizePath(input) {
    const raw = typeof input === 'string' ? input : input?.url || input?.href;
    try {
      // The game runs in srcdoc: location.href is about:srcdoc, while <base>
      // supplies the actual game URL used by the browser for relative fetches.
      return new URL(raw, window.document?.baseURI || window.location.href).pathname.replace(/\/{2,}/g, '/');
    } catch {
      return `/${String(raw || '').split(/[?#]/)[0]}`.replace(/\/{2,}/g, '/');
    }
  }

  async function bootstrapResponse() {
    return {
      chatId: bridge().getCurrentChatId(),
      runtimeVersions: bridge().getRuntimeVersions?.() || {},
      playerProfile: await Promise.resolve(bridge().getPlayerProfile()),
      buildMode: globalThis.__GALACTIC_EMPRESS_BUILD_MODE__ || 'release'
    };
  }

  function createJob(payload) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job = {
      id,
      status: 'queued',
      result: null,
      error: '',
      recoveryId: String(payload?.recoveryId || '').trim(),
      waitingForActiveRequest: false,
      expiry: null
    };
    jobs.set(id, job);
    Promise.resolve().then(async () => {
      job.status = 'running';
      try {
        const result = await bridge().request(payload);
        if (job.status !== 'completed') {
          job.result = result;
          job.status = 'completed';
          scheduleTerminalJobExpiry(job);
        }
      } catch (error) {
        if (job.status === 'completed' || recoverStoredJobResponse(job)) return;
        if (
          error?.code === 'TEXT_REQUEST_ACTIVE'
          && job.recoveryId
          && String(error?.activeRecoveryId || '') === job.recoveryId
        ) {
          // Retrying after a UI reload can race the original bridge request. It
          // is the same logical generation, so keep polling its independent
          // chat backup instead of reporting a false failure or generating twice.
          job.waitingForActiveRequest = true;
          return;
        }
        job.error = String(error?.message || error || '请求失败');
        job.status = 'failed';
        scheduleTerminalJobExpiry(job);
      }
    });
    return job;
  }

  function recoverStoredJobResponse(job) {
    if (job.status !== 'running' || !job.recoveryId) return false;
    try {
      // A helper may have already stored the complete reply but still be waiting
      // for a rendering extension. Only this request's independent backup counts;
      // never parse the displayed message or start a replacement generation.
      const recovered = bridge().loadStoryResponse?.(job.recoveryId, { requireRaw: true });
      if (!recovered?.found || typeof recovered.fullText !== 'string') return false;
      const fullText = recovered.fullText;
      job.result = {
        output: { textParts: [fullText.replace(/极其|极度/g, '')], thoughtParts: [], imageParts: [] },
        raw: { fullText, responseSource: 'chat_backup' }
      };
      job.error = '';
      job.status = 'completed';
      scheduleTerminalJobExpiry(job);
      return true;
    } catch {
      // A recovery lookup must not interrupt a generation that is still running.
      return false;
    }
  }

  function settleOrphanedRetry(job) {
    if (job.status !== 'running' || !job.waitingForActiveRequest) return;
    try {
      const state = bridge().getTextRequestState?.();
      if (!state || (state.active && String(state.recoveryId || '') === job.recoveryId)) return;
      job.error = '上一条生成已经结束，但没有找到可恢复的完整回复，请再次重试。';
      job.status = 'failed';
      scheduleTerminalJobExpiry(job);
    } catch {
      // If bridge state cannot be read, keep waiting for the durable backup.
    }
  }

  async function getRequestBody(input, init) {
    if (init?.body) return JSON.parse(init.body);
    if (typeof input !== 'string' && input?.clone) return input.clone().json();
    return {};
  }

  window.fetch = async (input, init = {}) => {
    const path = normalizePath(input);
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (!/(?:^|\/)api\//.test(path)) return originalFetch(input, init);

    if (path.endsWith('/api/game/bootstrap')) return jsonResponse(await bootstrapResponse());
    if (path.endsWith('/api/ai-settings')) {
      return jsonResponse({ settings: { provider: 'aiStudio', modelId: 'gemini-2.5-flash', configured: true } });
    }
    if (path.endsWith('/api/image-status') && method === 'GET') {
      return jsonResponse(await bridge().getImageGeneratorStatus());
    }
    if (path.endsWith('/api/image-setup') && method === 'POST') {
      return jsonResponse({ opened: await bridge().openImageSetup() });
    }
    if (path.endsWith('/api/image-test') && method === 'POST') {
      return jsonResponse(await bridge().testImageGenerator());
    }
    if (path.endsWith('/api/card-storage/chat') && method === 'GET') {
      return jsonResponse(await bridge().loadGameStorage());
    }
    if (path.endsWith('/api/card-storage/chat') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse(await bridge().saveGameStorage(payload.data, payload.chatId));
    }
    if (path.endsWith('/api/card-storage/resolve') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse({ data: bridge().resolveGameStorage(payload.data) });
    }
    if (path.endsWith('/api/story-response/recovery') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse(await bridge().loadStoryResponse(payload.recoveryId));
    }
    if (path.endsWith('/api/story-response/publish') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse(await bridge().publishStoryResponse(payload));
    }
    if (path.endsWith('/api/card-images/upload') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse(await bridge().uploadImage(payload));
    }
    if (path.endsWith('/api/tavern-display-regex') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse({ text: bridge().formatStoryTextForDisplay(payload.text) });
    }
    if (path.endsWith('/api/export-worldbook') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      return jsonResponse(await bridge().exportWorldbook(payload.runtime, payload.promptSettings));
    }
    if (path.endsWith('/api/generate') && method === 'POST') {
      const payload = await getRequestBody(input, init);
      const job = createJob(payload);
      return jsonResponse({ job: { id: job.id, status: job.status } }, 202);
    }
    const jobMatch = path.match(/\/api\/ai-jobs\/([^/]+)$/);
    if (jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) return jsonResponse({ error: 'AI 任务不存在。' }, 404);
      recoverStoredJobResponse(job);
      settleOrphanedRetry(job);
      const response = jsonResponse({ job: { id: job.id, status: job.status, result: job.result, error: job.error } });
      if (job.status === 'completed' || job.status === 'failed') deleteJob(job);
      return response;
    }
    return jsonResponse({ error: `酒馆版不支持接口：${path}` }, 404);
  };
})();
