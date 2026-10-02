export const STORAGE_ENVELOPE_FORMAT = 'galactic-empress-storage';
export const STORAGE_ENVELOPE_VERSION = 3;
const STORED_IMAGE_KEYS = new Set(['avatarUrl', 'avatarOriginalUrl', 'imageUrl', 'imageOriginalUrl']);

export function mapStoredImageUrls(value, mapper) {
  if (Array.isArray(value)) return value.map((item) => mapStoredImageUrls(item, mapper));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = STORED_IMAGE_KEYS.has(key) && typeof item === 'string'
      ? mapper(item)
      : mapStoredImageUrls(item, mapper);
  }
  return result;
}

export function normalizePortableImageUrls(value) {
  return mapStoredImageUrls(value, (item) => {
    const raw = String(item || '').trim();
    return raw.includes('/user/images/') ? raw.slice(raw.indexOf('/user/images/')) : raw;
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function transformBytes(bytes, Transform, format) {
  const stream = new Transform(format);
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await output);
}

export function isStorageEnvelope(value) {
  return value?.format === STORAGE_ENVELOPE_FORMAT
    && value?.version === STORAGE_ENVELOPE_VERSION
    && typeof value?.encoding === 'string'
    && typeof value?.payload === 'string';
}

export async function encodeStorageValue(value) {
  const json = JSON.stringify(value);
  const source = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    try {
      const compressed = await transformBytes(source, CompressionStream, 'gzip');
      return {
        format: STORAGE_ENVELOPE_FORMAT,
        version: STORAGE_ENVELOPE_VERSION,
        encoding: 'gzip-base64',
        payload: bytesToBase64(compressed),
        rawBytes: source.byteLength
      };
    } catch {
      // Older embedded browsers may expose an incomplete CompressionStream.
    }
  }
  return {
    format: STORAGE_ENVELOPE_FORMAT,
    version: STORAGE_ENVELOPE_VERSION,
    encoding: 'json',
    payload: json,
    rawBytes: source.byteLength
  };
}

export async function decodeStorageValue(envelope) {
  if (!isStorageEnvelope(envelope)) throw new Error('存档格式与当前版本不兼容。');
  let json;
  if (envelope.encoding === 'json') {
    json = envelope.payload;
  } else if (envelope.encoding === 'gzip-base64') {
    if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持读取压缩存档。');
    const compressed = base64ToBytes(envelope.payload);
    const restored = await transformBytes(compressed, DecompressionStream, 'gzip');
    json = new TextDecoder().decode(restored);
  } else {
    throw new Error(`不支持的存档编码：${envelope.encoding}`);
  }
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object') throw new Error('存档内容不是有效对象。');
  return value;
}
