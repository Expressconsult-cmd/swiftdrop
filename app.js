import { joinRoom } from 'https://esm.run/trystero@0.27.0';

const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB per file

// Unique namespace scoped to your GitHub Pages URL so PINs don't collide with other sites
const cleanPath = window.location.pathname.replace(/index\.html$/i, '');
const APP_ID =
  'swiftdrop-p2p-' +
  (window.location.host + cleanPath).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

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

const activePinDisplay = document.getElementById('activePinDisplay');
const copyPinBtn = document.getElementById('copyPinBtn');
const toggleQrBtn = document.getElementById('toggleQrBtn');
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

const peersMap = new Map(); // peerId -> { name, type }
const itemsMap = new Map(); // itemId -> { item, blobUrl? }
const transferRows = new Map(); // transferKey -> { row, fill, statSpan, startTime }
let localTextHistory = [];
let toastTimer = null;
let dragDepth = 0;

if (window.location.protocol === 'file:') {
  showBanner(
    'ES Modules require HTTPS/HTTP. Host these 3 files on GitHub Pages (or run a local server like VS Code Live Server) instead of opening index.html directly.'
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

  const saved = localStorage.getItem('swiftdrop_device_name');
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

function updateUrlPin(pin) {
  const url = new URL(window.location.href);
  if (pin) url.searchParams.set('pin', pin);
  else url.searchParams.delete('pin');
  window.history.replaceState({}, '', url.toString());
}

async function updateQrCode() {
  if (!activePin) return;
  const shareUrl = `${window.location.origin}${cleanPath}?pin=${activePin}`;
  shareUrlInput.value = shareUrl;
  if (window.QRCode && typeof window.QRCode.toDataURL === 'function') {
    try {
      qrImage.src = await window.QRCode.toDataURL(shareUrl, { width: 220, margin: 1 });
    } catch {
      // Ignore QR errors
    }
  }
}

function renderPeers() {
  peersStrip.innerHTML = '';

  // Self chip
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

function getOrCreateTransferRow(key, labelText) {
  transfersContainer.classList.remove('hidden');
  if (transferRows.has(key)) return transferRows.get(key);

  const row = document.createElement('div');
  row.className = 'upload-row';

  const meta = document.createElement('div');
  meta.className = 'upload-meta';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = labelText;

  const statSpan = document.createElement('span');
  statSpan.textContent = '0%';

  meta.append(nameSpan, statSpan);

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.appendChild(fill);

  row.append(meta, track);
  transfersContainer.prepend(row);

  const entry = { row, fill, statSpan, startTime: Date.now() };
  transferRows.set(key, entry);
  return entry;
}

function finishTransferRow(key, doneLabel = 'Done!') {
  const entry = transferRows.get(key);
  if (!entry) return;
  entry.fill.style.width = '100%';
  entry.statSpan.textContent = doneLabel;
  setTimeout(() => {
    entry.row.remove();
    transferRows.delete(key);
    if (transfersContainer.children.length === 0) {
      transfersContainer.classList.add('hidden');
    }
  }, 1200);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function addFeedItem(item, { blobUrl = null, isIncoming = false } = {}) {
  if (!item || itemsMap.has(item.id)) return;
  itemsMap.set(item.id, { item, blobUrl });

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

  if (item.kind === 'file') {
    title.textContent = `${item.name} (${formatBytes(item.size)})`;

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

  feedList.prepend(card);
  updateItemCount();
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

async function enterRoom(pin) {
  if (room) {
    await leaveCurrentRoom();
  }

  activePin = pin;
  activePinDisplay.textContent = `${pin.slice(0, 3)} ${pin.slice(3)}`;
  connectView.classList.add('hidden');
  roomView.classList.remove('hidden');
  updateUrlPin(pin);
  updateQrCode();
  renderPeers();

  room = joinRoom(
    {
      appId: APP_ID,
      maxReceiveBytes: MAX_FILE_BYTES + 64 * 1024 * 1024
    },
    pin
  );

  helloAction = room.makeAction('hello');
  textAction = room.makeAction('text-reflect');
  syncTextAction = room.makeAction('text-sync');
  fileAction = room.makeAction('file-drop');
  deleteAction = room.makeAction('delete-item');

  room.onPeerJoin(({ peerId }) => {
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

  fileAction.onReceive((offer) => {
    return offer.byteLength <= MAX_FILE_BYTES;
  });

  fileAction.onReceiveProgress((pct, { metadata }) => {
    const key = `recv-${metadata?.id || metadata?.name || 'file'}`;
    const entry = getOrCreateTransferRow(
      key,
      `Receiving ${metadata?.name || 'file'} (${formatBytes(metadata?.size || 0)})`
    );
    const percent = Math.min(100, Math.round(pct * 100));
    entry.fill.style.width = `${percent}%`;
    entry.statSpan.textContent = `${percent}%`;
  });

  fileAction.onMessage((bytes, { metadata }) => {
    const id = metadata?.id || crypto.randomUUID();
    const key = `recv-${id}`;
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
  if (room) {
    try {
      await room.leave();
    } catch {
      // Ignore cleanup errors
    }
  }
  room = null;
  activePin = null;
  helloAction = null;
  textAction = null;
  syncTextAction = null;
  fileAction = null;
  deleteAction = null;

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
    const entry = getOrCreateTransferRow(key, `Sending ${file.name} (${formatBytes(file.size)})`);

    const metadata = {
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      senderName: deviceInfo.name,
      createdAt: Date.now()
    };

    // Show local preview immediately
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
      { blobUrl: localUrl, isIncoming: false }
    );

    try {
      await fileAction.send(file, {
        metadata,
        onProgress: (pct) => {
          const percent = Math.min(100, Math.round(pct * 100));
          const elapsed = Math.max((Date.now() - entry.startTime) / 1000, 0.1);
          const speed = formatBytes((file.size * pct) / elapsed);
          entry.fill.style.width = `${percent}%`;
          entry.statSpan.textContent = `${percent}% • ${speed}/s`;
        }
      });
      finishTransferRow(key, 'Sent!');
    } catch (err) {
      entry.statSpan.textContent = 'Transfer failed';
      entry.statSpan.style.color = '#fca5a5';
      showToast(`Failed sending ${file.name}`);
    }
  }
}

// UI Events
devicePill.addEventListener('click', () => {
  const next = prompt('Enter a name for this device:', deviceInfo.name);
  if (next && next.trim()) {
    deviceInfo.name = next.trim().slice(0, 40);
    localStorage.setItem('swiftdrop_device_name', deviceInfo.name);
    deviceNameDisplay.textContent = deviceInfo.name;
    renderPeers();
    helloAction?.send({ name: deviceInfo.name, type: deviceInfo.type }).catch(() => {});
  }
});

createRoomBtn.addEventListener('click', () => {
  const pin = generateSixDigitPin();
  enterRoom(pin);
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
  enterRoom(pin);
});

copyPinBtn.addEventListener('click', () => {
  if (activePin) copyText(activePin, `PIN ${activePin} copied!`);
});

toggleQrBtn.addEventListener('click', () => {
  qrPanel.classList.toggle('hidden');
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
    enterRoom(clean);
  }
}