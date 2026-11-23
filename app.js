import { joinRoom } from 'https://esm.run/trystero@0.27.0';
import { createQrSvgDataUrl } from './qr.js?v=6';

const MAX_RELAY_FILE_BYTES = 100 * 1024 * 1024; // 100 MB over encrypted cloud relay
const MAX_P2P_FILE_BYTES = 500 * 1024 * 1024; // 500 MB over direct WebRTC P2P
const RELAY_CHUNK_BYTES = 32 * 1024; // 32 KB chunks tuned for low/slow mobile internet
const RELAY_BATCH_SIZE = 4; // 4 chunks per ACK window
const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

const APP_ID =
  'express-swiftdrop-v6-' +
  window.location.host.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Elements
const connectView = document.getElementById('connectView');
const roomView = document.getElementById('roomView');
const statusBanner = document.getElementById('statusBanner');
const devicePill = document.getElementById('devicePill');
const deviceIconEl = document.getElementById('deviceIcon');
const deviceNameDisplay = document.getElementById('deviceNameDisplay');

const createRoomBtn = document.getElementById('createRoomBtn');
const joinForm = document.getElementById('joinForm');
const pinInput = document.getElementById('pinInput');
const scanQrBtn = document.getElementById('scanQrBtn');

const scannerModal = document.getElementById('scannerModal');
const closeScannerBtn = document.getElementById('closeScannerBtn');
const scannerVideo = document.getElementById('scannerVideo');
const scannerCanvas = document.getElementById('scannerCanvas');
const scannerStatus = document.getElementById('scannerStatus');

const activePinDisplay = document.getElementById('activePinDisplay');
const copyPinBtn = document.getElementById('copyPinBtn');
const toggleQrBtn = document.getElementById('toggleQrBtn');
const relayStatusBadge = document.getElementById('relayStatusBadge');
const reconnectBtn = document.getElementById('reconnectBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const autoDownloadToggle = document.getElementById('autoDownloadToggle');

const qrPanel = document.getElementById('qrPanel');
const qrImage = document.getElementById('qrImage');
const shareUrlInput = document.getElementById('shareUrlInput');
const copyUrlBtn = document.getElementById('copyUrlBtn');

const peersStrip = document.getElementById('peersStrip');
const dropzone = document.getElementById('dropzone');
const browseBtn = document.getElementById('browseBtn');
const fileInput = document.getElementById('fileInput');
const dropOverlay = document.getElementById('dropOverlay');

const textForm = document.getElementById('textForm');
const textInput = document.getElementById('textInput');
const transfersContainer = document.getElementById('transfersContainer');
const feedList = document.getElementById('feedList');
const emptyFeed = document.getElementById('emptyFeed');
const itemCountBadge = document.getElementById('itemCountBadge');
const toastEl = document.getElementById('toast');

function makeUuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  window.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// State
const myId = makeUuid();
let activePin = null;
let roomTopic = null;
let aesKey = null;

// Relay state (MQTT over WSS)
let mqttClient = null;
let brokerIndex = 0;
let brokerFailoverTimer = null;
let relayHeartbeatTimer = null;
let peerPruneTimer = null;

// Optional WebRTC fast-lane state (Trystero)
let p2pRoom = null;
let p2pBindAction = null;
let p2pFileAction = null;
let p2pCancelAction = null;

let scannerStream = null;
let scannerRafId = null;

const peersMap = new Map(); // remoteId -> { id, name, type, lastSeen, webrtcPeerId }
const itemsMap = new Map(); // itemId -> { item, blobUrl, cancelBtn }
const transferRows = new Map(); // key -> { row, fill, statSpan, cancelBtn, startTime }
const activeSends = new Map(); // fileId -> AbortController
const cancelledReceives = new Set(); // fileId
const relayReceivingFiles = new Map(); // fileId -> { ... }
const relayBatchWaiters = new Map(); // `${fileId}:${batchIndex}` -> { resolve, receivedFrom: Set }
let localTextHistory = [];
let toastTimer = null;
let dragDepth = 0;

if (window.location.protocol === 'file:') {
  showBanner(
    'ES Modules require HTTPS/HTTP. Host these files on GitHub Pages (or run a local server) instead of opening index.html directly.'
  );
}

// Device detection
function detectDevice() {
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  let osName = 'Device';
  if (/iPhone/i.test(ua)) osName = 'iPhone';
  else if (/iPad/i.test(ua)) osName = 'iPad';
  else if (/Android/i.test(ua)) osName = 'Android';
  else if (/Windows/i.test(ua)) osName = 'Windows PC';
  else if (/Macintosh/i.test(ua)) osName = 'Mac';
  else if (/Linux/i.test(ua)) osName = 'Linux PC';

  let browser = '';
  if (/Edg/i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';

  const saved = localStorage.getItem('express_swiftdrop_name');
  return {
    name: saved || (browser ? `${osName} (${browser})` : osName),
    type: isMobile ? 'mobile' : 'desktop'
  };
}

const deviceInfo = detectDevice();
deviceIconEl.textContent = deviceInfo.type === 'mobile' ? '📱' : '💻';
deviceNameDisplay.textContent = deviceInfo.name;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2800);
}

function showBanner(message) {
  if (!message) {
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';
  } else {
    statusBanner.textContent = message;
    statusBanner.classList.remove('hidden');
  }
}

async function copyText(text, successMsg = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
    showToast(successMsg);
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function generateSixDigitPin() {
  const arr = new Uint32Array(1);
  window.crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

function updateUrlPin(pin) {
  const url = new URL(window.location.href);
  if (pin) url.searchParams.set('pin', pin);
  else url.searchParams.delete('pin');
  window.history.replaceState({}, '', url.toString());
}

function updateQrCode() {
  if (!activePin) return;
  const shareUrlObj = new URL(window.location.href);
  shareUrlObj.search = `?pin=${activePin}`;
  shareUrlObj.hash = '';
  const shareUrl = shareUrlObj.toString();

  shareUrlInput.value = shareUrl;
  try {
    qrImage.src = createQrSvgDataUrl(shareUrl, 4);
  } catch {
    showToast('Could not generate QR code');
  }
}

// End-to-End Encryption Helpers (AES-GCM-256 derived from APP_ID + PIN)
async function deriveRoomCrypto(pin) {
  if (window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      textEncoder.encode(`${APP_ID}:${pin}`)
    );
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = await window.crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    return { topic: `esd/v6/${hex.slice(0, 20)}`, key };
  }
  return { topic: `esd/v6/${APP_ID}_${pin}`, key: null };
}

async function sealPacket(typeByte, plainBytes) {
  if (aesKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      plainBytes
    );
    const cipher = new Uint8Array(cipherBuf);
    const out = new Uint8Array(1 + 12 + cipher.byteLength);
    out[0] = typeByte;
    out.set(iv, 1);
    out.set(cipher, 13);
    return out;
  }
  const out = new Uint8Array(1 + plainBytes.byteLength);
  out[0] = typeByte | 0x10;
  out.set(plainBytes, 1);
  return out;
}

async function openPacket(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (bytes.byteLength < 2) return null;
  const tag = bytes[0];

  if (tag === 0x01 || tag === 0x02) {
    if (!aesKey || bytes.byteLength < 14) return null;
    const iv = bytes.subarray(1, 13);
    const cipher = bytes.subarray(13);
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      cipher
    );
    return { type: tag, plain: new Uint8Array(plainBuf) };
  }
  if (tag === 0x11 || tag === 0x12) {
    return { type: tag & 0x0f, plain: bytes.subarray(1) };
  }
  return null;
}

async function publishJson(obj, qos = 1) {
  if (!mqttClient || !mqttClient.connected || !roomTopic) return;
  const plain = textEncoder.encode(JSON.stringify({ ...obj, from: myId }));
  const packet = await sealPacket(0x01, plain);
  mqttClient.publish(roomTopic, packet, { qos });
}

async function publishChunk(fileId, chunkIndex, chunkBytes) {
  if (!mqttClient || !mqttClient.connected || !roomTopic) {
    throw new Error('Relay offline');
  }
  const idBytes = textEncoder.encode(fileId);
  const plain = new Uint8Array(40 + chunkBytes.byteLength);
  plain.set(idBytes.subarray(0, 36), 0);
  new DataView(plain.buffer).setUint32(36, chunkIndex, false);
  plain.set(chunkBytes, 40);

  const packet = await sealPacket(0x02, plain);
  return new Promise((resolve, reject) => {
    mqttClient.publish(roomTopic, packet, { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Built-in Camera QR Scanner
function extractPinFromQr(rawText) {
  const text = String(rawText || '').trim();
  try {
    const parsed = new URL(text);
    const param = parsed.searchParams.get('pin');
    if (param) {
      const cleaned = param.replace(/\D/g, '');
      if (cleaned.length === 6) return cleaned;
    }
  } catch {
    // Not a URL
  }
  const digits = text.replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

function stopQrScanner() {
  if (scannerRafId) {
    cancelAnimationFrame(scannerRafId);
    scannerRafId = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  scannerVideo.srcObject = null;
  scannerModal.classList.add('hidden');
}

async function startQrScanner() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Camera access requires HTTPS and a supported browser.');
    return;
  }
  if (typeof window.jsQR !== 'function') {
    showToast('Camera QR scanner library is unavailable.');
    return;
  }

  scannerStatus.textContent = 'Starting camera...';
  scannerModal.classList.remove('hidden');

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();
    scannerStatus.textContent = 'Point your camera at the QR code on the other device...';

    const ctx = scannerCanvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!scannerStream) return;
      if (scannerVideo.readyState === scannerVideo.HAVE_ENOUGH_DATA) {
        scannerCanvas.width = scannerVideo.videoWidth;
        scannerCanvas.height = scannerVideo.videoHeight;
        ctx.drawImage(scannerVideo, 0, 0, scannerCanvas.width, scannerCanvas.height);

        const imgData = ctx.getImageData(0, 0, scannerCanvas.width, scannerCanvas.height);
        const code = window.jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: 'dontInvert'
        });

        if (code && code.data) {
          const pin = extractPinFromQr(code.data);
          if (pin) {
            stopQrScanner();
            showToast(`Scanned PIN ${pin}! Connecting...`);
            enterRoom(pin, { showQr: false });
            return;
          } else {
            scannerStatus.textContent = 'QR code found, but it is not an Express SwiftDrop room.';
          }
        }
      }
      scannerRafId = requestAnimationFrame(tick);
    };

    scannerRafId = requestAnimationFrame(tick);
  } catch {
    stopQrScanner();
    showToast('Camera permission denied or no camera found.');
  }
}

function renderPeers() {
  peersStrip.innerHTML = '';

  const selfChip = document.createElement('div');
  selfChip.className = 'peer-chip';
  const selfDot = document.createElement('span');
  selfDot.className = 'peer-dot';
  const selfIcon = document.createElement('span');
  selfIcon.textContent = deviceInfo.type === 'mobile' ? '📱' : '💻';
  const selfLabel = document.createElement('span');
  selfLabel.textContent = `${deviceInfo.name} (You)`;
  selfChip.append(selfDot, selfIcon, selfLabel);
  peersStrip.appendChild(selfChip);

  if (peersMap.size === 0) {
    const waitChip = document.createElement('div');
    waitChip.className = 'peer-chip';
    const waitDot = document.createElement('span');
    waitDot.className = 'peer-dot waiting';
    const waitText = document.createElement('span');
    waitText.textContent = 'Waiting for another device to join with PIN...';
    waitChip.append(waitDot, waitText);
    peersStrip.appendChild(waitChip);
    return;
  }

  for (const [, info] of peersMap.entries()) {
    const chip = document.createElement('div');
    chip.className = 'peer-chip';
    const dot = document.createElement('span');
    dot.className = 'peer-dot';
    const icon = document.createElement('span');
    icon.textContent = info.type === 'mobile' ? '📱' : '💻';
    const label = document.createElement('span');
    label.textContent = info.name || 'Peer Device';

    const modeBadge = document.createElement('span');
    modeBadge.className = info.webrtcPeerId ? 'peer-mode p2p' : 'peer-mode';
    modeBadge.textContent = info.webrtcPeerId ? '⚡ P2P' : '☁️ Relay';

    chip.append(dot, icon, label, modeBadge);
    peersStrip.appendChild(chip);
  }
}

function updateItemCount() {
  const count = itemsMap.size;
  itemCountBadge.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
  emptyFeed.classList.toggle('hidden', count > 0);
}

function removeTransferRow(key) {
  const entry = transferRows.get(key);
  if (!entry) return;
  entry.row.remove();
  transferRows.delete(key);
  if (transfersContainer.children.length === 0) {
    transfersContainer.classList.add('hidden');
  }
}

function getOrCreateTransferRow(key, labelText, onCancel) {
  transfersContainer.classList.remove('hidden');
  if (transferRows.has(key)) return transferRows.get(key);

  const row = document.createElement('div');
  row.className = 'upload-row';

  const meta = document.createElement('div');
  meta.className = 'upload-meta';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'upload-title';
  nameSpan.textContent = labelText;

  const right = document.createElement('div');
  right.className = 'upload-right';

  const statSpan = document.createElement('span');
  statSpan.textContent = '0%';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-danger btn-xs';
  cancelBtn.type = 'button';
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    onCancel?.();
  });

  right.append(statSpan, cancelBtn);
  meta.append(nameSpan, right);

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.appendChild(fill);

  row.append(meta, track);
  transfersContainer.prepend(row);

  const entry = { row, fill, statSpan, cancelBtn, startTime: Date.now() };
  transferRows.set(key, entry);
  return entry;
}

function finishTransferRow(key, doneLabel = 'Done!') {
  const entry = transferRows.get(key);
  if (!entry) return;
  entry.fill.style.width = '100%';
  entry.statSpan.textContent = doneLabel;
  entry.cancelBtn.classList.add('hidden');
  setTimeout(() => removeTransferRow(key), 1100);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function addFeedItem(item, { blobUrl = null, isIncoming = false, onCancelSend = null } = {}) {
  if (!item || itemsMap.has(item.id)) return;

  const card = document.createElement('article');
  card.className = 'card item-card';
  card.dataset.itemId = item.id;

  const top = document.createElement('div');
  top.className = 'item-top';

  const info = document.createElement('div');
  const senderLine = document.createElement('div');
  senderLine.className = 'item-sender';
  const who = item.isSelf ? `${item.senderName} (You)` : item.senderName;
  senderLine.textContent = `${who} • ${formatTime(item.createdAt)}`;

  const title = document.createElement('div');
  title.className = 'item-title';

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  let cardCancelBtn = null;

  if (item.kind === 'file') {
    title.textContent = `${item.name} (${formatBytes(item.size)})`;

    if (onCancelSend) {
      cardCancelBtn = document.createElement('button');
      cardCancelBtn.className = 'btn btn-danger btn-sm';
      cardCancelBtn.type = 'button';
      cardCancelBtn.textContent = '✕ Cancel Sending';
      cardCancelBtn.addEventListener('click', onCancelSend);
      actions.appendChild(cardCancelBtn);
    }

    if (blobUrl) {
      const dlBtn = document.createElement('a');
      dlBtn.className = 'btn btn-primary btn-sm';
      dlBtn.href = blobUrl;
      dlBtn.download = item.name;
      dlBtn.textContent = 'Download';
      actions.appendChild(dlBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm';
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => {
      if (activeSends.has(item.id)) {
        onCancelSend?.();
        return;
      }
      removeFeedItem(item.id);
      publishJson({ type: 'delete_item', itemId: item.id }).catch(() => {});
    });
    actions.appendChild(delBtn);

    info.append(senderLine, title);
    top.append(info, actions);
    card.appendChild(top);

    if (blobUrl) {
      if (item.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'preview-media';
        img.src = blobUrl;
        img.alt = item.name;
        card.appendChild(img);
      } else if (item.mimeType?.startsWith('video/')) {
        const video = document.createElement('video');
        video.className = 'preview-media';
        video.src = blobUrl;
        video.controls = true;
        video.preload = 'metadata';
        card.appendChild(video);
      } else if (item.mimeType?.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = blobUrl;
        audio.controls = true;
        audio.preload = 'metadata';
        card.appendChild(audio);
      }

      if (isIncoming && autoDownloadToggle.checked) {
        triggerDownload(blobUrl, item.name);
        showToast(`Auto-saving ${item.name}`);
      }
    }
  } else {
    title.textContent = 'Reflected Text';
    info.append(senderLine, title);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-secondary btn-sm';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyText(item.text, 'Text copied!'));
    actions.appendChild(copyBtn);

    if (/^https?:\/\/\S+$/i.test(item.text.trim())) {
      const openLink = document.createElement('a');
      openLink.className = 'btn btn-primary btn-sm';
      openLink.href = item.text.trim();
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.textContent = 'Open';
      actions.appendChild(openLink);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm';
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => {
      removeFeedItem(item.id);
      publishJson({ type: 'delete_item', itemId: item.id }).catch(() => {});
    });
    actions.appendChild(delBtn);

    top.append(info, actions);
    card.appendChild(top);

    const body = document.createElement('div');
    body.className = 'text-body';
    body.textContent = item.text;
    card.appendChild(body);
  }

  itemsMap.set(item.id, { item, blobUrl, cancelBtn: cardCancelBtn });
  feedList.prepend(card);
  updateItemCount();
}

function hideCardCancelButton(itemId) {
  const record = itemsMap.get(itemId);
  if (record?.cancelBtn) {
    record.cancelBtn.remove();
    record.cancelBtn = null;
  }
}

function removeFeedItem(itemId) {
  const record = itemsMap.get(itemId);
  if (!record) return;
  if (record.blobUrl) URL.revokeObjectURL(record.blobUrl);
  itemsMap.delete(itemId);
  localTextHistory = localTextHistory.filter((t) => t.id !== itemId);
  const el = feedList.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
  if (el) el.remove();
  updateItemCount();
}

// Handle incoming Cloud Relay messages
async function handleRelayPacket(rawPayload) {
  let decoded;
  try {
    decoded = await openPacket(rawPayload);
  } catch {
    return;
  }
  if (!decoded) return;

  if (decoded.type === 0x01) {
    let msg;
    try {
      msg = JSON.parse(textDecoder.decode(decoded.plain));
    } catch {
      return;
    }
    if (!msg || msg.from === myId) return;
    if (msg.to && msg.to !== myId) return;

    const remoteId = msg.from;

    if (msg.type === 'hello' || msg.type === 'hello_ack' || msg.type === 'ping') {
      const existing = peersMap.get(remoteId);
      const isNew = !existing;
      peersMap.set(remoteId, {
        id: remoteId,
        name: msg.name || existing?.name || 'Peer Device',
        type: msg.deviceType === 'mobile' ? 'mobile' : 'desktop',
        lastSeen: Date.now(),
        webrtcPeerId: existing?.webrtcPeerId || null
      });
      if (isNew || existing?.name !== msg.name) {
        renderPeers();
      }
      if (isNew) {
        showToast(`${msg.name || 'Device'} connected!`);
      }
      if (msg.type === 'hello') {
        publishJson({
          type: 'hello_ack',
          to: remoteId,
          name: deviceInfo.name,
          deviceType: deviceInfo.type
        }).catch(() => {});
        if (localTextHistory.length > 0) {
          publishJson({
            type: 'text_sync',
            to: remoteId,
            items: localTextHistory
          }).catch(() => {});
        }
      }
      return;
    }

    if (msg.type === 'bye') {
      const existing = peersMap.get(remoteId);
      if (existing) {
        peersMap.delete(remoteId);
        renderPeers();
        showToast(`${existing.name} left`);
      }
      return;
    }

    if (msg.type === 'text' && msg.item) {
      addFeedItem({ ...msg.item, isSelf: false }, { isIncoming: true });
      return;
    }

    if (msg.type === 'text_sync' && Array.isArray(msg.items)) {
      msg.items.forEach((item) => addFeedItem({ ...item, isSelf: false }, { isIncoming: false }));
      return;
    }

    if (msg.type === 'delete_item' && msg.itemId) {
      removeFeedItem(msg.itemId);
      return;
    }

    if (msg.type === 'file_meta' && msg.id) {
      if (cancelledReceives.has(msg.id) || relayReceivingFiles.has(msg.id)) return;
      if (msg.size > MAX_RELAY_FILE_BYTES) return;

      relayReceivingFiles.set(msg.id, {
        id: msg.id,
        senderId: remoteId,
        name: msg.name || 'shared-file',
        mimeType: msg.mimeType || 'application/octet-stream',
        size: msg.size || 0,
        totalChunks: msg.totalChunks || 1,
        senderName: msg.senderName || 'Peer Device',
        createdAt: msg.createdAt || Date.now(),
        chunks: new Array(msg.totalChunks || 1),
        receivedCount: 0
      });

      const key = `recv-${msg.id}`;
      getOrCreateTransferRow(
        key,
        `Receiving ${msg.name} (${formatBytes(msg.size)})`,
        () => {
          cancelledReceives.add(msg.id);
          relayReceivingFiles.delete(msg.id);
          removeTransferRow(key);
          publishJson({ type: 'file_cancel', id: msg.id, by: 'receiver', to: remoteId }).catch(() => {});
          showToast(`Stopped receiving ${msg.name}`);
        }
      );
      return;
    }

    if (msg.type === 'batch_ping' && msg.id) {
      const rec = relayReceivingFiles.get(msg.id);
      if (!rec) return;
      const missing = [];
      for (let i = msg.start; i <= msg.end; i++) {
        if (!rec.chunks[i]) missing.push(i);
      }
      publishJson({
        type: 'batch_ack',
        to: remoteId,
        id: msg.id,
        batchIndex: msg.batchIndex,
        missing
      }).catch(() => {});
      return;
    }

    if (msg.type === 'batch_ack' && msg.id) {
      const waiter = relayBatchWaiters.get(`${msg.id}:${msg.batchIndex}`);
      if (waiter) {
        waiter.handleAck(remoteId, msg.missing || []);
      }
      return;
    }

    if (msg.type === 'file_cancel' && msg.id) {
      if (msg.by === 'sender') {
        cancelledReceives.add(msg.id);
        relayReceivingFiles.delete(msg.id);
        removeTransferRow(`recv-${msg.id}`);
        showToast('Sender cancelled the file transfer.');
      } else if (msg.by === 'receiver') {
        const controller = activeSends.get(msg.id);
        if (controller && peersMap.size <= 1) {
          controller.abort();
          activeSends.delete(msg.id);
          removeTransferRow(`send-${msg.id}`);
          removeFeedItem(msg.id);
          showToast('Receiver cancelled the file transfer.');
        }
      }
    }
    return;
  }

  // Binary file chunk (0x02)
  if (decoded.type === 0x02 && decoded.plain.byteLength >= 40) {
    const fileId = textDecoder.decode(decoded.plain.subarray(0, 36));
    if (cancelledReceives.has(fileId)) return;

    const rec = relayReceivingFiles.get(fileId);
    if (!rec) return;

    const chunkIndex = new DataView(
      decoded.plain.buffer,
      decoded.plain.byteOffset,
      decoded.plain.byteLength
    ).getUint32(36, false);

    if (chunkIndex < 0 || chunkIndex >= rec.totalChunks) return;

    if (!rec.chunks[chunkIndex]) {
      rec.chunks[chunkIndex] = decoded.plain.slice(40);
      rec.receivedCount++;
    }

    const key = `recv-${fileId}`;
    const entry = transferRows.get(key);
    if (entry) {
      const pct = Math.min(100, Math.round((rec.receivedCount / rec.totalChunks) * 100));
      const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
      const bytesSoFar = Math.min(rec.size, rec.receivedCount * RELAY_CHUNK_BYTES);
      entry.fill.style.width = `${pct}%`;
      entry.statSpan.textContent = `${pct}% • ${formatBytes(bytesSoFar / elapsed)}/s`;
    }

    if (rec.receivedCount === rec.totalChunks) {
      relayReceivingFiles.delete(fileId);
      let totalLen = 0;
      for (let i = 0; i < rec.totalChunks; i++) {
        if (!rec.chunks[i]) return;
        totalLen += rec.chunks[i].byteLength;
      }
      const merged = new Uint8Array(totalLen);
      let pos = 0;
      for (let i = 0; i < rec.totalChunks; i++) {
        merged.set(rec.chunks[i], pos);
        pos += rec.chunks[i].byteLength;
        rec.chunks[i] = null;
      }

      finishTransferRow(key, 'Received!');
      const blob = new Blob([merged], { type: rec.mimeType });
      const blobUrl = URL.createObjectURL(blob);

      addFeedItem(
        {
          id: rec.id,
          kind: 'file',
          name: rec.name,
          mimeType: rec.mimeType,
          size: rec.size || blob.size,
          senderName: rec.senderName,
          createdAt: rec.createdAt,
          isSelf: false
        },
        { blobUrl, isIncoming: true }
      );
    }
  }
}

function connectMqttRelay(pin) {
  if (typeof window.mqtt?.connect !== 'function') {
    relayStatusBadge.textContent = 'Cloud: offline';
    relayStatusBadge.classList.remove('online');
    showBanner('MQTT library failed to load. Check internet connection and refresh.');
    return;
  }

  const brokerUrl = RELAY_BROKERS[brokerIndex % RELAY_BROKERS.length];
  relayStatusBadge.textContent = 'Cloud: connecting...';
  relayStatusBadge.classList.remove('online');

  const client = window.mqtt.connect(brokerUrl, {
    clientId: `esd_${myId.slice(0, 12)}_${Math.random().toString(16).slice(2, 6)}`,
    clean: true,
    keepalive: 20,
    connectTimeout: 12000,
    reconnectPeriod: 2500
  });
  mqttClient = client;

  clearTimeout(brokerFailoverTimer);
  brokerFailoverTimer = setTimeout(() => {
    if (mqttClient === client && !client.connected && activePin === pin) {
      brokerIndex++;
      client.end(true);
      connectMqttRelay(pin);
    }
  }, 11000);

  client.on('connect', () => {
    if (mqttClient !== client || activePin !== pin) return;
    clearTimeout(brokerFailoverTimer);
    showBanner('');
    relayStatusBadge.textContent = 'Cloud: online';
    relayStatusBadge.classList.add('online');

    client.subscribe(roomTopic, { qos: 1 }, (err) => {
      if (!err) {
        publishJson({
          type: 'hello',
          name: deviceInfo.name,
          deviceType: deviceInfo.type
        }).catch(() => {});
      }
    });
  });

  client.on('message', (topic, message) => {
    if (topic === roomTopic) {
      handleRelayPacket(message);
    }
  });

  client.on('reconnect', () => {
    if (mqttClient !== client) return;
    relayStatusBadge.textContent = 'Cloud: reconnecting...';
    relayStatusBadge.classList.remove('online');
  });

  client.on('offline', () => {
    if (mqttClient !== client) return;
    relayStatusBadge.textContent = 'Cloud: reconnecting...';
    relayStatusBadge.classList.remove('online');
  });

  clearInterval(relayHeartbeatTimer);
  relayHeartbeatTimer = setInterval(() => {
    if (mqttClient?.connected) {
      publishJson({
        type: 'ping',
        name: deviceInfo.name,
        deviceType: deviceInfo.type
      }, 0).catch(() => {});
    }
  }, 10000);

  clearInterval(peerPruneTimer);
  peerPruneTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, info] of peersMap.entries()) {
      if (!info.webrtcPeerId && now - info.lastSeen > 35000) {
        peersMap.delete(id);
        changed = true;
      }
    }
    if (changed) renderPeers();
  }, 5000);
}

// Optional WebRTC Direct P2P Upgrade (completely silent if blocked by LTE/NAT)
function startOptionalP2p(pin) {
  try {
    p2pRoom = joinRoom(
      {
        appId: APP_ID,
        identity: 'none',
        maxReceiveBytes: MAX_P2P_FILE_BYTES + 64 * 1024 * 1024
      },
      pin
    );
  } catch {
    return;
  }

  p2pRoom.onError(() => {
    // Silently ignore WebRTC NAT/LTE failures — Cloud Relay handles everything seamlessly
  });

  p2pBindAction = p2pRoom.makeAction('bind');
  p2pFileAction = p2pRoom.makeAction('p2p-file');
  p2pCancelAction = p2pRoom.makeAction('p2p-cancel');

  p2pRoom.onPeerJoin(({ peerId }) => {
    p2pBindAction.send({ id: myId, name: deviceInfo.name, type: deviceInfo.type }, { target: peerId }).catch(() => {});
  });

  p2pRoom.onPeerLeave(({ peerId }) => {
    let changed = false;
    for (const [, info] of peersMap.entries()) {
      if (info.webrtcPeerId === peerId) {
        info.webrtcPeerId = null;
        changed = true;
      }
    }
    if (changed) renderPeers();
  });

  p2pBindAction.onMessage((info, { peerId }) => {
    if (!info?.id || info.id === myId) return;
    const existing = peersMap.get(info.id);
    peersMap.set(info.id, {
      id: info.id,
      name: info.name || existing?.name || 'Peer Device',
      type: info.type === 'mobile' ? 'mobile' : 'desktop',
      lastSeen: Date.now(),
      webrtcPeerId: peerId
    });
    renderPeers();
  });

  p2pCancelAction.onMessage((payload) => {
    const id = payload?.id;
    if (!id) return;
    if (payload.by === 'sender') {
      cancelledReceives.add(id);
      removeTransferRow(`recv-${id}`);
      showToast('Sender cancelled the file transfer.');
    } else if (payload.by === 'receiver') {
      const controller = activeSends.get(id);
      if (controller && peersMap.size <= 1) {
        controller.abort();
        activeSends.delete(id);
        removeTransferRow(`send-${id}`);
        removeFeedItem(id);
        showToast('Receiver cancelled the file transfer.');
      }
    }
  });

  p2pFileAction.onReceive(({ byteLength, metadata }) => {
    if (metadata?.id && cancelledReceives.has(metadata.id)) return false;
    return byteLength <= MAX_P2P_FILE_BYTES;
  });

  p2pFileAction.onReceiveProgress((pct, { peerId, metadata }) => {
    const id = metadata?.id || metadata?.name || 'file';
    if (cancelledReceives.has(id)) return;
    const key = `recv-${id}`;
    const name = metadata?.name || 'file';

    const entry = getOrCreateTransferRow(
      key,
      `Receiving ${name} (${formatBytes(metadata?.size || 0)})`,
      () => {
        cancelledReceives.add(id);
        removeTransferRow(key);
        p2pCancelAction?.send({ id, by: 'receiver' }, { target: peerId }).catch(() => {});
        showToast(`Stopped receiving ${name}`);
      }
    );

    const percent = Math.min(100, Math.round(pct * 100));
    const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
    const speed = metadata?.size ? ` • ${formatBytes((metadata.size * pct) / elapsed)}/s` : '';
    entry.fill.style.width = `${percent}%`;
    entry.statSpan.textContent = `${percent}%${speed}`;
  });

  p2pFileAction.onMessage((bytes, { metadata }) => {
    const id = metadata?.id || makeUuid();
    const key = `recv-${id}`;
    if (cancelledReceives.has(id)) {
      cancelledReceives.delete(id);
      removeTransferRow(key);
      return;
    }

    finishTransferRow(key, 'Received!');
    const mimeType = metadata?.type || 'application/octet-stream';
    const blob = new Blob([bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    addFeedItem(
      {
        id,
        kind: 'file',
        name: metadata?.name || 'shared-file',
        mimeType,
        size: metadata?.size || blob.size,
        senderName: metadata?.senderName || 'Peer Device',
        createdAt: metadata?.createdAt || Date.now(),
        isSelf: false
      },
      { blobUrl, isIncoming: true }
    );
  });
}

async function enterRoom(pin, { showQr = false } = {}) {
  await leaveCurrentRoom();

  showBanner('');
  activePin = pin;
  activePinDisplay.textContent = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  connectView.classList.add('hidden');
  roomView.classList.remove('hidden');
  qrPanel.classList.toggle('hidden', !showQr);
  updateUrlPin(pin);
  updateQrCode();
  renderPeers();

  const cryptoData = await deriveRoomCrypto(pin);
  if (activePin !== pin) return;
  roomTopic = cryptoData.topic;
  aesKey = cryptoData.key;

  connectMqttRelay(pin);
  startOptionalP2p(pin);
}

async function leaveCurrentRoom() {
  clearTimeout(brokerFailoverTimer);
  clearInterval(relayHeartbeatTimer);
  clearInterval(peerPruneTimer);
  brokerFailoverTimer = null;
  relayHeartbeatTimer = null;
  peerPruneTimer = null;

  for (const [, controller] of activeSends.entries()) {
    try {
      controller.abort();
    } catch {}
  }
  activeSends.clear();
  cancelledReceives.clear();
  relayReceivingFiles.clear();
  relayBatchWaiters.clear();

  if (mqttClient) {
    try {
      await publishJson({ type: 'bye' }, 0);
    } catch {}
    try {
      mqttClient.end(true);
    } catch {}
    mqttClient = null;
  }

  if (p2pRoom) {
    try {
      await p2pRoom.leave();
    } catch {}
    p2pRoom = null;
  }
  p2pBindAction = null;
  p2pFileAction = null;
  p2pCancelAction = null;

  activePin = null;
  roomTopic = null;
  aesKey = null;

  showBanner('');
  peersMap.clear();
  for (const [, record] of itemsMap.entries()) {
    if (record.blobUrl) URL.revokeObjectURL(record.blobUrl);
  }
  itemsMap.clear();
  localTextHistory = [];
  transferRows.clear();
  transfersContainer.innerHTML = '';
  transfersContainer.classList.add('hidden');
  feedList.innerHTML = '';
  qrPanel.classList.add('hidden');
  roomView.classList.add('hidden');
  connectView.classList.remove('hidden');
  pinInput.value = '';
  updateUrlPin(null);
  updateItemCount();
}

// Reliable Chunked File Sender over Encrypted Cloud Relay
async function waitForBatchAck(fileId, batchIndex, targetIds, signal) {
  return new Promise((resolve) => {
    const key = `${fileId}:${batchIndex}`;
    const missingMap = new Map();
    const ackedPeers = new Set();

    const finish = (missingIndices) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      relayBatchWaiters.delete(key);
      resolve(missingIndices);
    };

    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort);

    const timer = setTimeout(() => {
      const union = new Set();
      for (const arr of missingMap.values()) arr.forEach((idx) => union.add(idx));
      finish(Array.from(union));
    }, 15000);

    relayBatchWaiters.set(key, {
      handleAck: (peerId, missing) => {
        ackedPeers.add(peerId);
        if (Array.isArray(missing) && missing.length > 0) {
          missingMap.set(peerId, missing);
        }
        const allDone = targetIds.every((id) => ackedPeers.has(id) || !peersMap.has(id));
        if (allDone) {
          const union = new Set();
          for (const arr of missingMap.values()) arr.forEach((idx) => union.add(idx));
          finish(Array.from(union));
        }
      }
    });
  });
}

async function sendFileViaRelay(file, id, controller, entry) {
  const totalChunks = Math.max(1, Math.ceil(file.size / RELAY_CHUNK_BYTES));
  const targetIds = Array.from(peersMap.keys());

  await publishJson({
    type: 'file_meta',
    id,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    totalChunks,
    senderName: deviceInfo.name,
    createdAt: Date.now()
  });

  let sentChunks = 0;
  let batchIndex = 0;

  for (let start = 0; start < totalChunks; start += RELAY_BATCH_SIZE) {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(totalChunks - 1, start + RELAY_BATCH_SIZE - 1);

    const sendSingleChunk = async (idx) => {
      const sliceStart = idx * RELAY_CHUNK_BYTES;
      const sliceEnd = Math.min(file.size, sliceStart + RELAY_CHUNK_BYTES);
      const buf = await file.slice(sliceStart, sliceEnd).arrayBuffer();
      await publishChunk(id, idx, new Uint8Array(buf));
    };

    for (let idx = start; idx <= end; idx++) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await sendSingleChunk(idx);
      sentChunks++;
      const pct = Math.min(99, Math.round((sentChunks / totalChunks) * 100));
      const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
      const speed = formatBytes((sentChunks * RELAY_CHUNK_BYTES) / elapsed);
      entry.fill.style.width = `${pct}%`;
      entry.statSpan.textContent = `${pct}% • ${speed}/s`;
    }

    // Confirm batch on slow/low internet and retry any missing chunks
    for (let attempt = 0; attempt < 3; attempt++) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const ackPromise = waitForBatchAck(id, batchIndex, targetIds, controller.signal);
      await publishJson({ type: 'batch_ping', id, batchIndex, start, end });
      const missing = await ackPromise;
      if (missing === null) throw new DOMException('Aborted', 'AbortError');
      if (missing.length === 0) break;
      for (const mIdx of missing) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        await sendSingleChunk(mIdx);
      }
    }

    batchIndex++;
  }
}

async function sendFiles(fileList) {
  if (!activePin) return;
  if (peersMap.size === 0) {
    showToast('Wait for your other device to connect with the PIN first!');
    return;
  }

  const allDirectP2p =
    p2pFileAction && Array.from(peersMap.values()).every((p) => Boolean(p.webrtcPeerId));
  const maxBytes = allDirectP2p ? MAX_P2P_FILE_BYTES : MAX_RELAY_FILE_BYTES;

  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > maxBytes) {
      showToast(
        `${file.name} exceeds ${allDirectP2p ? '500 MB P2P' : '100 MB Relay'} limit.`
      );
      continue;
    }

    const id = makeUuid();
    const key = `send-${id}`;
    const controller = new AbortController();
    activeSends.set(id, controller);

    const cancelThisSend = () => {
      if (!activeSends.has(id)) return;
      controller.abort();
      activeSends.delete(id);
      publishJson({ type: 'file_cancel', id, by: 'sender' }).catch(() => {});
      p2pCancelAction?.send({ id, by: 'sender' }).catch(() => {});
      removeTransferRow(key);
      removeFeedItem(id);
      showToast(`Cancelled sending ${file.name}`);
    };

    const entry = getOrCreateTransferRow(
      key,
      `Sending ${file.name} (${formatBytes(file.size)})`,
      cancelThisSend
    );

    const metadata = {
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      senderName: deviceInfo.name,
      createdAt: Date.now()
    };

    const localUrl = URL.createObjectURL(file);
    addFeedItem(
      {
        id,
        kind: 'file',
        name: file.name,
        mimeType: metadata.type,
        size: file.size,
        senderName: deviceInfo.name,
        createdAt: metadata.createdAt,
        isSelf: true
      },
      { blobUrl: localUrl, isIncoming: false, onCancelSend: cancelThisSend }
    );

    const transferPromise = allDirectP2p
      ? p2pFileAction.send(file, {
          metadata,
          signal: controller.signal,
          onProgress: (pct) => {
            const percent = Math.min(100, Math.round(pct * 100));
            const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
            const speed = formatBytes((file.size * pct) / elapsed);
            entry.fill.style.width = `${percent}%`;
            entry.statSpan.textContent = `${percent}% • ${speed}/s`;
          }
        })
      : sendFileViaRelay(file, id, controller, entry);

    transferPromise
      .then(() => {
        activeSends.delete(id);
        hideCardCancelButton(id);
        finishTransferRow(key, 'Sent!');
      })
      .catch((err) => {
        const wasCancelled =
          controller.signal.aborted || err?.kind === 'aborted' || err?.name === 'AbortError';
        activeSends.delete(id);
        hideCardCancelButton(id);
        if (wasCancelled) {
          removeTransferRow(key);
          removeFeedItem(id);
          return;
        }
        entry.cancelBtn.classList.add('hidden');
        entry.statSpan.textContent = err?.kind === 'rejected' ? 'Declined' : 'Transfer failed';
        entry.statSpan.style.color = '#fca5a5';
        showToast(`Failed sending ${file.name}`);
      });
  }
}

// UI Events
devicePill.addEventListener('click', () => {
  const next = prompt('Enter a name for this device:', deviceInfo.name);
  if (next && next.trim()) {
    deviceInfo.name = next.trim().slice(0, 40);
    localStorage.setItem('express_swiftdrop_name', deviceInfo.name);
    deviceNameDisplay.textContent = deviceInfo.name;
    renderPeers();
    publishJson({
      type: 'hello',
      name: deviceInfo.name,
      deviceType: deviceInfo.type
    }).catch(() => {});
  }
});

createRoomBtn.addEventListener('click', () => {
  const pin = generateSixDigitPin();
  enterRoom(pin, { showQr: true });
});

pinInput.addEventListener('input', () => {
  pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = pinInput.value.replace(/\D/g, '');
  if (pin.length !== 6) {
    showToast('Please enter a 6-digit PIN.');
    pinInput.focus();
    return;
  }
  enterRoom(pin, { showQr: false });
});

scanQrBtn.addEventListener('click', startQrScanner);
closeScannerBtn.addEventListener('click', stopQrScanner);
scannerModal.addEventListener('click', (e) => {
  if (e.target === scannerModal) stopQrScanner();
});

copyPinBtn.addEventListener('click', () => {
  if (activePin) copyText(activePin, `PIN ${activePin} copied!`);
});

toggleQrBtn.addEventListener('click', () => {
  qrPanel.classList.toggle('hidden');
});

reconnectBtn.addEventListener('click', () => {
  if (!activePin) return;
  showToast('Reconnecting...');
  enterRoom(activePin, { showQr: !qrPanel.classList.contains('hidden') });
});

copyUrlBtn.addEventListener('click', () => {
  copyText(shareUrlInput.value, 'Room link copied!');
});

leaveRoomBtn.addEventListener('click', leaveCurrentRoom);

browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropzone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    sendFiles(fileInput.files);
    fileInput.value = '';
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-active');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-active');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-active');
  if (e.dataTransfer?.files?.length) sendFiles(e.dataTransfer.files);
});

window.addEventListener('dragenter', (e) => {
  if (!activePin) return;
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragDepth++;
    dropOverlay.classList.remove('hidden');
  }
});

window.addEventListener('dragleave', () => {
  if (!activePin) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});

window.addEventListener('dragover', (e) => {
  if (activePin) e.preventDefault();
});

window.addEventListener('drop', (e) => {
  if (!activePin) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  if (e.target !== dropzone && !dropzone.contains(e.target) && e.dataTransfer?.files?.length) {
    sendFiles(e.dataTransfer.files);
  }
});

textForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text || !activePin) return;

  const item = {
    id: makeUuid(),
    kind: 'text',
    text,
    senderName: deviceInfo.name,
    createdAt: Date.now()
  };

  localTextHistory.push(item);
  if (localTextHistory.length > 50) localTextHistory.shift();

  addFeedItem({ ...item, isSelf: true });
  textInput.value = '';

  if (peersMap.size > 0) {
    publishJson({ type: 'text', item }).catch(() => {});
  } else {
    showToast('Saved locally — will reflect automatically when a device joins!');
  }
});

textInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    textForm.requestSubmit();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activePin && mqttClient) {
    if (!mqttClient.connected) {
      mqttClient.reconnect();
    } else {
      publishJson({
        type: 'hello',
        name: deviceInfo.name,
        deviceType: deviceInfo.type
      }).catch(() => {});
    }
  }
});

// Auto-join if opened from QR code (?pin=123456)
const queryPin = new URLSearchParams(window.location.search).get('pin');
if (queryPin) {
  const clean = queryPin.replace(/\D/g, '');
  if (clean.length === 6) {
    enterRoom(clean, { showQr: false });
  }
}
