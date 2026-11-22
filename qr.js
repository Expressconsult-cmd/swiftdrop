// Pure JavaScript QR Code Generator (ISO/IEC 18004, Versions 1-10, Level M, UTF-8 Byte Mode)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let gfVal = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = gfVal;
  EXP[i + 255] = gfVal;
  LOG[gfVal] = i;
  gfVal <<= 1;
  if (gfVal & 0x100) gfVal ^= 0x11d;
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsEncode(data, ecCount) {
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(gen.length + 1).fill(0);
    const root = EXP[i];
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], root);
    }
    gen = next;
  }

  const rem = new Uint8Array(data.length + ecCount);
  rem.set(data);
  for (let i = 0; i < data.length; i++) {
    const lead = rem[i];
    if (lead === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      rem[i + j] ^= gfMul(gen[j], lead);
    }
  }
  return rem.slice(data.length);
}

// [version, totalDataCw, ecPerBlock, g1Blocks, g1Cw, g2Blocks, g2Cw, byteCapacity]
const LEVEL_M_SPECS = [
  [1, 16, 10, 1, 16, 0, 0, 14],
  [2, 28, 16, 1, 28, 0, 0, 26],
  [3, 44, 26, 1, 44, 0, 0, 42],
  [4, 64, 18, 2, 32, 0, 0, 62],
  [5, 86, 24, 2, 43, 0, 0, 84],
  [6, 108, 16, 4, 27, 0, 0, 106],
  [7, 124, 18, 4, 31, 0, 0, 122],
  [8, 154, 22, 2, 38, 2, 39, 152],
  [9, 182, 22, 3, 36, 2, 37, 180],
  [10, 216, 26, 4, 43, 1, 44, 213]
];

const ALIGN_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

function getFormatBits(mask) {
  // Error Correction Level M = 00
  const d = mask << 10;
  let rem = d;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((d | rem) ^ 0x5412) & 0x7fff;
}

function getVersionBits(version) {
  const d = version << 12;
  let rem = d;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (d | rem) & 0x3ffff;
}

function maskCondition(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2 + (r * c) % 3) === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    default: return false;
  }
}

function computePenalty(grid, size) {
  let penalty = 0;

  // Rule 1: 5+ consecutive same-color modules in rows/cols
  for (let r = 0; r < size; r++) {
    let runR = 1;
    let runC = 1;
    for (let i = 1; i < size; i++) {
      if (grid[r][i] === grid[r][i - 1]) {
        runR++;
        if (runR === 5) penalty += 3;
        else if (runR > 5) penalty += 1;
      } else {
        runR = 1;
      }

      if (grid[i][r] === grid[i - 1][r]) {
        runC++;
        if (runC === 5) penalty += 3;
        else if (runC > 5) penalty += 1;
      } else {
        runC = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const val = grid[r][c];
      if (val === grid[r][c + 1] && val === grid[r + 1][c] && val === grid[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: Finder-like 1:1:3:1:1 patterns
  const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let matchRA = true;
      let matchRB = true;
      let matchCA = true;
      let matchCB = true;
      for (let k = 0; k < 11; k++) {
        if (grid[r][c + k] !== patA[k]) matchRA = false;
        if (grid[r][c + k] !== patB[k]) matchRB = false;
        if (grid[c + k][r] !== patA[k]) matchCA = false;
        if (grid[c + k][r] !== patB[k]) matchCB = false;
      }
      if (matchRA || matchRB) penalty += 40;
      if (matchCA || matchCB) penalty += 40;
    }
  }

  // Rule 4: Dark ratio balance
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark += grid[r][c];
  }
  const pct = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  penalty += k * 10;

  return penalty;
}

function buildBitStream(bytes, spec) {
  const [version, totalDataCw] = spec;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Byte mode (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataCw * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);

  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let cw = 0;
    for (let j = 0; j < 8; j++) cw = (cw << 1) | bits[i + j];
    codewords.push(cw);
  }

  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < totalDataCw) {
    codewords.push(pads[padIdx % 2]);
    padIdx++;
  }

  return new Uint8Array(codewords);
}

function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const spec = LEVEL_M_SPECS.find((s) => bytes.length <= s[7]);
  if (!spec) {
    throw new Error('Text too long for QR Version 1-10');
  }

  const [version, , ecPerBlock, g1Blocks, g1Cw, g2Blocks, g2Cw] = spec;
  const dataCw = buildBitStream(bytes, spec);

  // Split into RS blocks
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1Blocks; i++) {
    const block = dataCw.slice(offset, offset + g1Cw);
    offset += g1Cw;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataCw.slice(offset, offset + g2Cw);
    offset += g2Cw;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // Interleave codewords
  const finalBytes = [];
  const maxDataLen = Math.max(g1Cw, g2Cw);
  for (let col = 0; col < maxDataLen; col++) {
    for (const blk of dataBlocks) {
      if (col < blk.length) finalBytes.push(blk[col]);
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (const ecBlk of ecBlocks) {
      finalBytes.push(ecBlk[col]);
    }
  }

  const bitStream = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >> i) & 1);
  }

  const size = 17 + 4 * version;
  const base = Array.from({ length: size }, () => new Uint8Array(size));
  const isFn = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, val) => {
    base[r][c] = val;
    isFn[r][c] = 1;
  };

  // Finder patterns + 1-module separators
  const drawFinder = (r0, c0) => {
    for (let r = r0 - 1; r <= r0 + 7; r++) {
      for (let c = c0 - 1; c <= c0 + 7; c++) {
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dr = r - r0;
        const dc = c - c0;
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inBox &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(r, c, dark ? 1 : 0);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    setFn(6, i, val);
    setFn(i, 6, val);
  }

  // Alignment patterns
  const centers = ALIGN_CENTERS[version];
  for (const cr of centers) {
    for (const cc of centers) {
      const nearTL = cr <= 8 && cc <= 8;
      const nearTR = cr <= 8 && cc >= size - 8;
      const nearBL = cr >= size - 8 && cc <= 8;
      if (nearTL || nearTR || nearBL) continue;

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(cr + dr, cc + dc, dist === 1 ? 0 : 1);
        }
      }
    }
  }

  // Fixed dark module
  setFn(size - 8, 8, 1);

  // Reserve format info zones
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFn[8][i] = 1;
      isFn[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFn[8][size - 1 - i] = 1;
    if (i < 7) isFn[size - 1 - i][8] = 1;
  }

  // Version info (versions 7+)
  if (version >= 7) {
    const vBits = getVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      setFn(size - 11 + b, a, bit);
      setFn(a, size - 11 + b, bit);
    }
  }

  // Zigzag placement
  let bitIdx = 0;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = up ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (!isFn[r][c]) {
          base[r][c] = bitIdx < bitStream.length ? bitStream[bitIdx] : 0;
          bitIdx++;
        }
      }
    }
    up = !up;
  }

  // Choose lowest-penalty mask
  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid = null;

  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row) => new Uint8Array(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFn[r][c] && maskCondition(mask, r, c)) {
          grid[r][c] ^= 1;
        }
      }
    }

    const fmt = getFormatBits(mask);
    // Copy 1
    for (let i = 0; i <= 5; i++) grid[8][i] = (fmt >> (14 - i)) & 1;
    grid[8][7] = (fmt >> 8) & 1;
    grid[8][8] = (fmt >> 7) & 1;
    grid[7][8] = (fmt >> 6) & 1;
    for (let i = 0; i <= 5; i++) grid[5 - i][8] = (fmt >> (5 - i)) & 1;

    // Copy 2
    for (let i = 0; i < 7; i++) grid[size - 1 - i][8] = (fmt >> (14 - i)) & 1;
    for (let i = 0; i < 8; i++) grid[8][size - 8 + i] = (fmt >> (7 - i)) & 1;

    const score = computePenalty(grid, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = grid;
    }
  }

  return { size, grid: bestGrid, mask: bestMask };
}

export function createQrSvg(text, quietZone = 4) {
  const { size, grid } = encodeQrMatrix(text);
  const total = size + quietZone * 2;
  let pathData = '';

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        pathData += `M${c + quietZone},${r + quietZone}h1v1h-1z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path fill="#0f172a" d="${pathData}"/>` +
    `</svg>`
  );
}

export function createQrSvgDataUrl(text, quietZone = 4) {
  const svg = createQrSvg(text, quietZone);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}