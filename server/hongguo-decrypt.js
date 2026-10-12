'use strict';
/**
 * 红果 MP4 CENC（AES-CTR 样本级）解密 —— Node 移植版
 * 逻辑移植自 gybeyond1/hongguo-dl 的 HongguoDecrypt.java（标准 AES + MP4 box 解析）。
 * 输入：加密 mp4 文件路径 + 16 字节内容密钥（hex，由 spade_a 派生，APK 端解析时已算好）
 * 输出：可播放的明文 mp4 文件
 */
const crypto = require('crypto');
const fs = require('fs');

function hexDecode(s) {
  return Buffer.from(s, 'hex');
}

/** AES-CTR 样本解密：keystream = AES-ECB(concat(nonce||BE(0), nonce||BE(1), ...))，与密文异或。 */
function decryptSample(key, nonce, cipher) {
  const nblocks = Math.ceil(cipher.length / 16);
  const full = Buffer.alloc(nblocks * 16);
  for (let k = 0; k < nblocks; k++) {
    nonce.copy(full, k * 16, 0, 8);
    full.writeUInt32BE(k, k * 16 + 8);        // 高 4 字节 = 块序号（大端）
    full.writeUInt32BE(0, k * 16 + 12);       // 低 4 字节 = 0
  }
  const ecb = crypto.createCipheriv('aes-128-ecb', key, null);
  ecb.setAutoPadding(false);
  const ks = Buffer.concat([ecb.update(full), ecb.final()]);
  const out = Buffer.allocUnsafe(cipher.length);
  for (let i = 0; i < cipher.length; i++) out[i] = cipher[i] ^ ks[i];
  return out;
}

/** MP4 box 解析：返回 box 列表（含 children）。 */
function parseBoxes(data, start, end) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = data.readUInt32BE(off);
    const typ = data.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;
    let children = null;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta'].includes(typ)) {
      children = parseBoxes(data, off + hdr, off + size);
    }
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}

function walkStbl(boxes, out) {
  for (const b of boxes) {
    if (b.typ === 'stbl') out.push(b);
    if (b.children) walkStbl(b.children, out);
  }
}

function findStsd(box, data, patches) {
  if (box.typ === 'stsd') {
    const content = box.off + 8;
    const count = data.readUInt32BE(content + 4);
    let p = content + 8;
    const chunks = [];
    for (let e = 0; e < count; e++) {
      const esize = data.readUInt32BE(p);
      const etyp = data.toString('latin1', p + 4, p + 8);
      if (etyp === 'encv' || etyp === 'enca') {
        const hdrSize = etyp === 'encv' ? 78 : 28;
        let newType;
        if (etyp === 'encv') {
          let isH265 = false;
          let q2 = p + 8 + hdrSize;
          while (q2 + 8 <= p + esize) {
            const s3 = data.readUInt32BE(q2);
            const t3 = data.toString('latin1', q2 + 4, q2 + 8);
            if (t3 === 'hvcC') { isH265 = true; break; }
            if (t3 === 'avcC') break;
            q2 += s3;
          }
          newType = isH265 ? 'hvc1' : 'avc1';
        } else newType = 'mp4a';
        const entryParts = [Buffer.alloc(4), Buffer.from(newType, 'latin1')];
        entryParts.push(data.subarray(p + 8, p + 8 + hdrSize));
        let q = p + 8 + hdrSize;
        while (q + 8 <= p + esize) {
          let s2 = data.readUInt32BE(q);
          const t2 = data.toString('latin1', q + 4, q + 8);
          if (s2 === 1) s2 = Number(data.readBigUInt64BE(q + 8));
          else if (s2 === 0) s2 = p + esize - q;
          if (t2 !== 'sinf') entryParts.push(data.subarray(q, q + s2));
          q += s2;
        }
        const fullEntry = Buffer.concat(entryParts);
        fullEntry.writeUInt32BE(fullEntry.length, 0);
        chunks.push(fullEntry);
      } else {
        chunks.push(data.subarray(p, p + esize));
      }
      p += esize;
    }
    const hdrLen = content + 8 - box.off;
    const entries = Buffer.concat(chunks);
    const fullResult = Buffer.alloc(hdrLen + entries.length);
    data.copy(fullResult, 0, box.off, box.off + hdrLen);
    entries.copy(fullResult, hdrLen);
    fullResult.writeUInt32BE(fullResult.length, 0);
    fullResult.writeUInt32BE(count, 12);
    patches.set(box.off, fullResult);
  }
  if (box.children) for (const c of box.children) findStsd(c, data, patches);
}

function rebuildBox(box, data, patches) {
  if (!box.children) return patches.get(box.off) || data.subarray(box.off, box.off + box.size);
  const bodyParts = [];
  for (const c of box.children) {
    if (['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].includes(c.typ)) continue;
    bodyParts.push(rebuildBox(c, data, patches));
  }
  const bodyBytes = Buffer.concat(bodyParts);
  if (box.hdr === 8) {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(8 + bodyBytes.length, 0);
    data.copy(hdr, 4, box.off + 4, box.off + 8);
    return Buffer.concat([hdr, bodyBytes]);
  }
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32BE(1, 0);
  data.copy(hdr, 4, box.off + 4, box.off + 8);
  hdr.writeBigUInt64BE(BigInt(16 + bodyBytes.length), 8);
  return Buffer.concat([hdr, bodyBytes]);
}

function findStco(box, data, delta) {
  if (box.typ === 'stco' || box.typ === 'co64') {
    const nc = data.readUInt32BE(box.off + 12);
    if (box.typ === 'stco') {
      for (let i = 0; i < nc; i++) {
        const at = box.off + 16 + i * 4;
        const v = data.readUInt32BE(at);
        if (v >= delta) data.writeUInt32BE(v - delta, at);
      }
    } else {
      for (let i = 0; i < nc; i++) {
        const at = box.off + 16 + i * 8;
        const v = data.readBigUInt64BE(at);
        if (v >= BigInt(delta)) data.writeBigUInt64BE(v - BigInt(delta), at);
      }
    }
  }
  if (box.children) for (const c of box.children) findStco(c, data, delta);
}

/**
 * 解密红果加密 mp4 文件。
 * @param {string} srcPath 加密文件路径
 * @param {string} dstPath 输出明文文件路径
 * @param {Buffer} key 16 字节 AES 内容密钥
 */
function decryptMp4File(srcPath, dstPath, key) {
  const data = fs.readFileSync(srcPath);
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find(b => b.typ === 'moov');
  if (!moov) throw new Error('未找到 moov box，不是有效的红果加密视频');

  const stbls = [];
  walkStbl(top, stbls);

  for (const stbl of stbls) {
    const children = {};
    for (const c of stbl.children) children[c.typ] = c;
    const stsz = children.stsz;
    let stco = children.stco;
    if (!stco) stco = children.co64;
    const stsc = children.stsc;
    const senc = children.senc;
    if (!stsz || !stco || !stsc) continue;

    const ss = data.readUInt32BE(stsz.off + 12);
    const n = data.readUInt32BE(stsz.off + 16);
    const sizes = [];
    if (ss === 0) {
      for (let i = 0; i < n; i++) sizes.push(data.readUInt32BE(stsz.off + 20 + i * 4));
    } else {
      for (let i = 0; i < n; i++) sizes.push(ss);
    }
    const isCo64 = stco.typ === 'co64';
    const nc = data.readUInt32BE(stco.off + 12);
    const chunkOffs = [];
    if (isCo64) {
      for (let i = 0; i < nc; i++) chunkOffs.push(Number(data.readBigUInt64BE(stco.off + 16 + i * 8)));
    } else {
      for (let i = 0; i < nc; i++) chunkOffs.push(data.readUInt32BE(stco.off + 16 + i * 4));
    }
    const ns = data.readUInt32BE(stsc.off + 12);
    const stscTab = [];
    for (let i = 0; i < ns; i++) {
      stscTab.push([data.readUInt32BE(stsc.off + 16 + i * 12), data.readUInt32BE(stsc.off + 20 + i * 12)]);
    }
    const ivs = [];
    if (senc) {
      const sc = data.readUInt32BE(senc.off + 12);
      const sencFlags = data.readUInt32BE(senc.off + 8);
      let ivSize = 8;
      let ivDataStart;
      if ((sencFlags & 0x2) !== 0) {
        ivSize = data[senc.off + 16];
        ivDataStart = senc.off + 17;
      } else ivDataStart = senc.off + 16;
      for (let i = 0; i < sc; i++) ivs.push(data.subarray(ivDataStart + i * ivSize, ivDataStart + (i + 1) * ivSize));
    }
    const chunkSpc = new Map();
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const spc = stscTab[i][1];
      const nxt = (i + 1 < stscTab.length) ? stscTab[i + 1][0] : nc + 1;
      for (let ci = fc - 1; ci < nxt - 1; ci++) chunkSpc.set(ci, spc);
    }
    const sampleOffs = [];
    let si = 0;
    for (let ci = 0; ci < nc; ci++) {
      let off = chunkOffs[ci];
      const spc = chunkSpc.get(ci) || 1;
      for (let j = 0; j < spc; j++) {
        if (si >= n) break;
        sampleOffs.push(off);
        off += sizes[si];
        si++;
      }
    }
    for (let i = 0; i < sampleOffs.length; i++) {
      const off = sampleOffs[i];
      const sz = sizes[i];
      if (off + sz > total || i >= ivs.length) continue;
      const nonce = ivs[i].subarray(0, 8);
      const cipher = data.subarray(off, off + sz);
      const plain = decryptSample(key, nonce, cipher);
      plain.copy(data, off);
    }
  }

  // stsd 补丁：encv/enca -> avc1/hvc1/mp4a，去掉 sinf
  const patches = new Map();
  for (const b of top) findStsd(b, data, patches);

  const newMoov = rebuildBox(moov, data, patches);
  const delta = moov.size - newMoov.length;

  // 调整 stco/co64 偏移
  for (const b of top) findStco(b, data, delta);

  const newMoov2 = rebuildBox(moov, data, patches);

  const outParts = [];
  let off = 0;
  while (off < total) {
    let size = data.readUInt32BE(off);
    const typ = data.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) size = total - off;
    if (typ === 'moov') outParts.push(newMoov2);
    else outParts.push(data.subarray(off, off + size));
    off += size;
  }
  fs.writeFileSync(dstPath, Buffer.concat(outParts));
}

module.exports = { decryptMp4File, decryptSample, parseBoxes };
