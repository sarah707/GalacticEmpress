export async function copyTextToClipboard(text, {
  navigatorObject = globalThis.navigator,
  documentObject = globalThis.document
} = {}) {
  const value = String(text ?? '');
  if (typeof navigatorObject?.clipboard?.writeText === 'function') {
    try {
      await navigatorObject.clipboard.writeText(value);
      return;
    } catch {
      // Sandboxed card iframes may deny this API; use the legacy copy path below.
    }
  }

  if (!documentObject?.body || typeof documentObject.execCommand !== 'function') {
    throw new Error('当前环境不支持写入剪贴板。');
  }
  const textarea = documentObject.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  documentObject.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = documentObject.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('复制提示词失败，请检查浏览器剪贴板权限。');
}
