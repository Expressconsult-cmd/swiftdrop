import { joinRoom, getRelaySockets } from 'https://esm.run/trystero@0.27.0';
import { createQrSvgDataUrl } from './qr.js?v=5';

const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB per file

// Optional: paste your free Metered TURN API URL here so ALL devices automatically work across LTE/Wi-Fi
// Example: 'https://yourapp.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY'
const DEFAULT_TURN_API_URL = '';

const APP_ID =
  'express-swiftdrop-v5-' +
  window.location.host.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

// Elements
const connectView = document.getElementById('connectView');
const roomView = document.getElementById('roomView');
const statusBanner = document.getElementById('statusBanner');
const devicePill = document.getElementById('devicePill');
const deviceIconEl = document.getElementById('deviceIcon');
const deviceNameDisplay = document.getElementById('deviceNameDisplay');

const turnBtn = document.getElementById('turnBtn');
const turnModal = document.getElementById('turnModal');
const closeTurnBtn = document.getElementById('closeTurnBtn');
const turnForm = document.getElementById('turnForm');
const turnUrlInput = document.getElementById('turnUrlInput');
const clearTurnBtn = document.getElementById('clearTurnBtn');

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

// State
let room = null;
let activePin = null;
let helloAction = null;
let textAction = null;
let syncTextAction = null;
let fileAction = null;
let deleteAction = null;
let cancelTransferAction = null;

let relayPollTimer = null;
let scannerStream = null;
let scannerRafId = null;

const peersMap = new Map();
const itemsMap = new Map();
const transferRows = new Map();
const activeSends = new Map();
const cancelledReceives = new Set();
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
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

function getTurnApiUrl() {
  return (localStorage.getItem('express_swiftdrop_turn_url') || DEFAULT_TURN_API_URL || '').trim();
}

async function fetchTurnServers() {
  const url = getTurnApiUrl();
  if (!url) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((entry) => {
      const urls = Array.isArray(entry?.urls) ? entry.urls.join(',') : String(entry?.urls || '');
      return urls.includes('turn:');
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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

function updateRelayStatus() {
  try {
    const sockets = Object.values(getRelaySockets() || {});
    const openCount = sockets.filter((s) => s && s.readyState === WebSocket.OPEN).length;
    if (openCount > 0) {
      relayStatusBadge.textContent = `Relays: ${openCount} online`;
      relayStatusBadge.classList.add('online');
    } else {
      relayStatusBadge.textContent = 'Relays: connecting...';
      relayStatusBadge.classList.remove('online');
    }
  } catch {
    relayStatusBadge.textContent = 'Relays: active';
    relayStatusBadge.classList.add('online');
  }
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
    chip.append(dot, icon, label);
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
      deleteAction?.send({ itemId: item.id }).catch(() => {});
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
      deleteAction?.send({ itemId: item.id }).catch(() => {});
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

async function enterRoom(pin, { showQr = false } = {}) {
  if (room) {
    await leaveCurrentRoom();
  }

  showBanner('');
  activePin = pin;
  activePinDisplay.textContent = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  connectView.classList.add('hidden');
  roomView.classList.remove('hidden');
  qrPanel.classList.toggle('hidden', !showQr);
  updateUrlPin(pin);
  updateQrCode();
  renderPeers();

  const turnServers = await fetchTurnServers();
  if (activePin !== pin) return;

  try {
    const roomConfig = {
      appId: APP_ID,
      identity: 'none',
      maxReceiveBytes: MAX_FILE_BYTES + 64 * 1024 * 1024
    };
    if (turnServers.length > 0) {
      roomConfig.turnConfig = turnServers;
    }

    room = joinRoom(roomConfig, pin);
  } catch (err) {
    showBanner(`Could not start room: ${err?.message || 'Connection error'}`);
    return;
  }

  updateRelayStatus();
  clearInterval(relayPollTimer);
  relayPollTimer = setInterval(updateRelayStatus, 2000);

  room.onError((err) => {
    const code = err?.code || '';
    if (code === 'peer-connect-failed') {
      showBanner(
        'Devices found each other, but your mobile LTE / firewall / VPN blocked direct P2P. Quick fix: connect both devices to the same Wi-Fi or Phone Hotspot (disable VPN) and tap Reconnect — or add a free TURN URL in ⚙ TURN.'
      );
    } else if (code === 'relay-failed') {
      showBanner('Signaling relay unreachable. Check your internet connection and tap Reconnect.');
    } else if (err?.message) {
      showBanner(err.message);
    }
  });

  helloAction = room.makeAction('hello');
  textAction = room.makeAction('text-reflect');
  syncTextAction = room.makeAction('text-sync');
  fileAction = room.makeAction('file-drop');
  deleteAction = room.makeAction('delete-item');
  cancelTransferAction = room.makeAction('cancel-transfer');

  room.onPeerJoin(({ peerId }) => {
    showBanner('');
    if (!peersMap.has(peerId)) {
      peersMap.set(peerId, { name: 'Connected Device', type: 'desktop' });
    }
    renderPeers();
    helloAction.send({ name: deviceInfo.name, type: deviceInfo.type }, { target: peerId }).catch(() => {});
    if (localTextHistory.length > 0) {
      syncTextAction.send(localTextHistory, { target: peerId }).catch(() => {});
    }
  });

  room.onPeerLeave(({ peerId }) => {
    const info = peersMap.get(peerId);
    peersMap.delete(peerId);
    renderPeers();
    if (info?.name) showToast(`${info.name} disconnected`);
  });

  helloAction.onMessage((info, { peerId }) => {
    const isNew = peersMap.get(peerId)?.name === 'Connected Device';
    peersMap.set(peerId, {
      name: info?.name || 'Peer Device',
      type: info?.type === 'mobile' ? 'mobile' : 'desktop'
    });
    renderPeers();
    if (isNew && info?.name) {
      showToast(`${info.name} connected!`);
    }
  });

  textAction.onMessage((payload) => {
    if (!payload?.id || !payload?.text) return;
    addFeedItem({ ...payload, isSelf: false }, { isIncoming: true });
  });

  syncTextAction.onMessage((historyList) => {
    if (!Array.isArray(historyList)) return;
    historyList.forEach((item) => {
      addFeedItem({ ...item, isSelf: false }, { isIncoming: false });
    });
  });

  deleteAction.onMessage((payload) => {
    if (payload?.itemId) removeFeedItem(payload.itemId);
  });

  cancelTransferAction.onMessage((payload) => {
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

  fileAction.onReceive(({ byteLength, metadata }) => {
    if (metadata?.id && cancelledReceives.has(metadata.id)) return false;
    return byteLength <= MAX_FILE_BYTES;
  });

  fileAction.onReceiveProgress((pct, { peerId, metadata }) => {
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
        cancelTransferAction?.send({ id, by: 'receiver' }, { target: peerId }).catch(() => {});
        showToast(`Stopped receiving ${name}`);
      }
    );

    const percent = Math.min(100, Math.round(pct * 100));
    const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
    const speed = metadata?.size ? ` • ${formatBytes((metadata.size * pct) / elapsed)}/s` : '';
    entry.fill.style.width = `${percent}%`;
    entry.statSpan.textContent = `${percent}%${speed}`;
  });

  fileAction.onMessage((bytes, { metadata }) => {
    const id = metadata?.id || crypto.randomUUID();
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

async function leaveCurrentRoom() {
  clearInterval(relayPollTimer);
  relayPollTimer = null;

  for (const [, controller] of activeSends.entries()) {
    try {
      controller.abort();
    } catch {}
  }
  activeSends.clear();
  cancelledReceives.clear();

  if (room) {
    try {
      await room.leave();
    } catch {}
  }
  room = null;
  activePin = null;
  helloAction = null;
  textAction = null;
  syncTextAction = null;
  fileAction = null;
  deleteAction = null;
  cancelTransferAction = null;

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

async function sendFiles(fileList) {
  if (!room || !fileAction) return;
  if (peersMap.size === 0) {
    showToast('Wait for your other device to connect with the PIN before dropping files!');
    return;
  }

  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} is over 500 MB limit.`);
      continue;
    }

    const id = crypto.randomUUID();
    const key = `send-${id}`;
    const controller = new AbortController();
    activeSends.set(id, controller);

    const cancelThisSend = () => {
      if (!activeSends.has(id)) return;
      controller.abort();
      activeSends.delete(id);
      cancelTransferAction?.send({ id, by: 'sender' }).catch(() => {});
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

    fileAction
      .send(file, {
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
    helloAction?.send({ name: deviceInfo.name, type: deviceInfo.type }).catch(() => {});
  }
});

turnBtn.addEventListener('click', () => {
  turnUrlInput.value = localStorage.getItem('express_swiftdrop_turn_url') || '';
  turnModal.classList.remove('hidden');
});

closeTurnBtn.addEventListener('click', () => turnModal.classList.add('hidden'));
turnModal.addEventListener('click', (e) => {
  if (e.target === turnModal) turnModal.classList.add('hidden');
});

turnForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = turnUrlInput.value.trim();
  if (val) {
    localStorage.setItem('express_swiftdrop_turn_url', val);
    showToast('TURN URL saved! Tap Reconnect if in a room.');
  } else {
    localStorage.removeItem('express_swiftdrop_turn_url');
  }
  turnModal.classList.add('hidden');
});

clearTurnBtn.addEventListener('click', () => {
  localStorage.removeItem('express_swiftdrop_turn_url');
  turnUrlInput.value = '';
  turnModal.classList.add('hidden');
  showToast('TURN URL cleared.');
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
  showToast('Reconnecting room...');
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
  if (!text || !textAction) return;

  const item = {
    id: crypto.randomUUID(),
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
    textAction.send(item).catch(() => {});
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

// Auto-join if opened from QR code (?pin=123456)
const queryPin = new URLSearchParams(window.location.search).get('pin');
if (queryPin) {
  const clean = queryPin.replace(/\D/g, '');
  if (clean.length === 6) {
    enterRoom(clean, { showQr: false });
  }
}
