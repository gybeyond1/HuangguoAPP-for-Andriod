'use strict';
/**
 * 橙子短剧后端 · 下载系统
 *
 * 职责：NAS 端整剧下载 + 合并。
 *  - 任务由 APK 提交（APK 已用自身解析链路把每集播放地址算好，红果附内容密钥 hex）
 *  - 红果：ffmpeg -decryption_key 原生解密下载（与 juku-backend 一致）
 *  - 黄果：直接下载明文分集
 *  - 合并参考 juku-backend：ffprobe 探测各集编码，一致则 concat -c copy 无损合并，
 *    不一致则先逐集统一转码（libx264/aac，中间文件留在 .merge-work 断点续传），再合并。
 *  - 合并成功后删除分集，只保留整剧单文件。任务状态持久化 DATA_DIR/downloads.json。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync, spawn } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/data';
// 下载合并产物目录：固定 /video，由 docker-compose 挂载 NAS 目录出来（本地测试可用 DOWNLOAD_DIR 覆盖）
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/video';
const CONCURRENCY = Math.max(1, parseInt(process.env.DOWNLOAD_CONCURRENCY || '2', 10) || 2);
const RETRIES = 2;
const TASKS_FILE = path.join(DATA_DIR, 'downloads.json');
const REDOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 播放地址默认时效：超时后任务判失败（APK 重新提交）

const HONGGUO_VIDEO_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const HONGGUO_REFERER = 'https://novel.snssdk.com/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- 任务存储 ----
let tasks = {}; // id -> task
let storeDirty = false;
let storeTimer = null;
function loadTasks() {
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks || {}; } catch { tasks = {}; }
  // 重启后把未完成任务标记为中断（临时文件保留，便于排查；不自动恢复下载）
  for (const t of Object.values(tasks)) {
    if (t.status === 'downloading' || t.status === 'merging' || t.status === 'queued') {
      t.status = 'failed';
      t.error = '服务重启，任务中断';
      t.updatedAt = Date.now();
    }
  }
  storeDirty = true;
}
function flushStore(force) {
  if (!storeDirty && !force) return;
  storeDirty = false;
  try {
    const tmp = TASKS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
  } catch (e) { console.error('[download] 保存任务状态失败:', e.message); storeDirty = true; }
}
function scheduleFlush() {
  if (storeTimer) return;
  storeTimer = setTimeout(() => { storeTimer = null; flushStore(false); }, 1500);
}
function touch(task) { task.updatedAt = Date.now(); storeDirty = true; scheduleFlush(); }

// ---- 工具 ----
function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
}
function safeJoin(base, name) {
  const target = path.resolve(base, name);
  if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error('非法路径');
  return target;
}
function httpGet(url, headers, onData, onEnd, onError) {
  const mod = url.startsWith('https:') ? https : http;
  const req = mod.get(url, { headers }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      httpGet(new URL(res.headers.location, url).toString(), headers, onData, onEnd, onError);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      onError(new Error(`下载失败 HTTP ${res.statusCode}`));
      return;
    }
    res.on('data', onData);
    res.on('end', onEnd);
  });
  req.on('error', onError);
  req.setTimeout(60_000, () => req.destroy(new Error('下载超时')));
  return req;
}
function downloadFile(url, destPath, headers, progressCb, signal) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let lastTick = 0;
    let aborted = false;
    let req = null;
    const abort = err => {
      if (aborted) return;
      aborted = true;
      file.removeAllListeners();
      file.on('error', () => {});
      try { file.destroy(); } catch { /* ignore */ }
      reject(err || new Error('任务已取消'));
    };
    const onData = chunk => {
      if (signal && signal.aborted) { if (req) req.destroy(); return; }
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 300) { lastTick = now; if (progressCb) progressCb(received); }
      if (!file.write(chunk)) { /* 背压不处理，量级小 */ }
    };
    req = httpGet(url, headers,
      onData,
      () => { file.end(() => { if (progressCb) progressCb(received); resolve(); }); },
      err => { file.destroy(); abort(err); });
    file.on('error', err => abort(err));
    if (signal) {
      const check = setInterval(() => {
        if (signal.aborted) { clearInterval(check); if (req) req.destroy(); abort(new Error('任务已取消')); }
      }, 300);
      file.on('close', () => clearInterval(check));
    }
  });
}

// ---- 合并（对照 juku-backend media_merge.go / media_merge_plan.go 完整移植）----
function probeFile(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,profile,sample_rate,channels,channel_layout,duration,time_base,pix_fmt,codec_tag_string',
    '-of', 'json', file], { encoding: 'utf8', timeout: 60_000 });
  if (out.status !== 0) throw new Error('ffprobe 探测失败: ' + (out.stderr || '').slice(0, 300));
  const parsed = JSON.parse(out.stdout);
  const video = (parsed.streams || []).find(s => s.codec_type === 'video');
  const audio = (parsed.streams || []).find(s => s.codec_type === 'audio');
  if (!video) throw new Error('分集没有视频轨道');
  const tb = String(video.time_base || '').split('/');
  const atb = audio ? String(audio.time_base || '').split('/') : [];
  return {
    videoCodec: video.codec_name,
    width: video.width, height: video.height, vProfile: video.profile || '',
    vTag: video.codec_tag_string || '',
    pixFmt: video.pix_fmt || '',
    videoTB: video.time_base || '',
    audioCodec: audio ? audio.codec_name : null,
    aProfile: audio ? audio.profile || '' : '',
    sampleRate: audio ? Number(audio.sample_rate) : 0,
    channels: audio ? Number(audio.channels) : 0,
    layout: audio ? audio.channel_layout || '' : '',
    audioTB: audio ? audio.time_base || '' : '',
    duration: Number(video.duration) || 0,
    timescale: tb.length === 2 ? Number(tb[1]) || 0 : 0,
    audioTimescale: atb.length === 2 ? Number(atb[1]) || 0 : 0,
  };
}
function videoKey(info) { return `${info.videoCodec}|${info.width}x${info.height}|${info.vProfile}|${info.pixFmt}|${info.vTag}`; }
function audioKey(info) { return `${info.audioCodec}|${info.aProfile}|${info.sampleRate}|${info.layout}`; }
function majorityKey(infos, key) {
  const counts = new Map();
  for (const info of infos) { const k = key(info); counts.set(k, (counts.get(k) || 0) + 1); }
  let best = null, bestN = -1;
  for (const [k, n] of counts) { if (n > bestN) { best = k; bestN = n; } }
  return best;
}
function majorityValue(infos, field, key) {
  const m = majorityKey(infos, key);
  for (const info of infos) { if (key(info) === m) return info[field]; }
  return infos[0] ? infos[0][field] : null;
}
const H264_PROFILES = { 'constrained baseline': 'baseline', baseline: 'baseline', main: 'main', high: 'high', 'high 10': 'high10' };

/** 合并计划（对照 juku-backend planMergeMedia）：majority 视频/音频 + 统一 timescale + 逐集 remux/转码判定 */
function buildPlan(infos) {
  const vk = majorityKey(infos, videoKey);
  const plan = { video: vk, timescale: 90000, parameters: false, steps: [] };
  const tbScale = majorityValue(infos, 'timescale', videoKey);
  if (tbScale > 0 && tbScale <= 10000000) plan.timescale = tbScale;
  const videoTB = `1/${plan.timescale}`;
  const ak = majorityKey(infos.filter(i => i.audioCodec), audioKey) || '';
  const audioTs = majorityValue(infos.filter(i => i.audioCodec), 'audioTimescale', audioKey) || 0;
  for (const info of infos) {
    const step = {
      video: videoKey(info) !== plan.video,
      audio: !!info.audioCodec && audioKey(info) !== ak,
      remux: false,
    };
    if (step.video || step.remux || (info.vTag && info.vTag !== infos[0].vTag)) plan.parameters = true;
    step.remux = info.videoTB !== videoTB || (!!info.audioCodec && info.audioTimescale !== audioTs);
    plan.steps.push(step);
  }
  return plan;
}
function runFFmpeg(args, progressCb) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 4096) stderr = stderr.slice(-4096); });
    proc.on('close', code => {
      if (code === 0) { if (progressCb) progressCb(1); resolve(); }
      else reject(new Error('FFmpeg 处理失败: ' + stderr.slice(0, 500)));
    });
    proc.on('error', reject);
    progressCb && progressCb(0);
  });
}

/** 合并分集 -> 单文件（对照 juku-backend media_merge.go）。workDir 为 .merge-work 断点续传目录，全部成功后才清理。 */
async function mergeEpisodes(episodeFiles, outputPath, workDir, report) {
  const infos = [];
  for (let i = 0; i < episodeFiles.length; i++) {
    report(Math.round(i * 5 / episodeFiles.length), `检测分集编码 ${i + 1}/${episodeFiles.length}`);
    try { infos.push(probeFile(episodeFiles[i])); }
    catch (e) { throw new Error(`第 ${i + 1} 集编码检测失败: ${e.message}`); }
  }
  const plan = buildPlan(infos);
  const prepared = new Array(episodeFiles.length);
  const majority = infos.reduce((a, b) => (videoKey(b) === plan.video ? b : a));
  const targetW = majority.width, targetH = majority.height;
  const targetSR = majority.sampleRate || 44100;
  const targetCh = majority.channels || 2;
  const h264Profile = H264_PROFILES[majority.vProfile?.toLowerCase()] || 'high';

  for (let i = 0; i < episodeFiles.length; i++) {
    const info = infos[i];
    const step = plan.steps[i];
    if (!step.video && !step.audio && !step.remux) { prepared[i] = episodeFiles[i]; continue; }
    // 断点续传：已处理的集直接复用
    const cooked = safeJoin(workDir, `ep${String(i + 1).padStart(3, '0')}.mp4`);
    if (fs.existsSync(cooked) && fs.statSync(cooked).size > 1024) { prepared[i] = cooked; continue; }
    const action = step.video ? '统一转码视频+音轨' : (step.audio ? '统一音轨' : '无损换封装(统一时间基)');
    report(5 + Math.round(i * 55 / episodeFiles.length), `${action}第 ${i + 1} 集`);
    const args = ['-i', episodeFiles[i], '-map', '0:v:0', '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'copy'];
    if (step.video) {
      let filter = 'setpts=PTS-STARTPTS,';
      if (targetW && targetH) {
        filter += `scale=w='min(iw,${targetW})':h='min(ih,${targetH})':force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,`;
      }
      args.push('-vf', filter.slice(0, -1));
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-profile:v', h264Profile, '-pix_fmt', 'yuv420p');
    }
    if (info.audioCodec) {
      args.push('-map', '0:a:0');
      if (step.audio) {
        args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', String(targetSR), '-ac', String(targetCh));
        args.push('-af', `aresample=${targetSR}:async=1:first_pts=0`);
      } else {
        args.push('-c:a', 'copy');
      }
    } else {
      args.push('-an');
    }
    // 转码时按本集视频时长截断输出，避免 apad 无限补静音导致音画不同步 / ffmpeg 永不结束
    if (step.video || step.audio) args.push('-t', String(info.duration || 0));
    args.push('-max_muxing_queue_size', '4096');
    args.push('-video_track_timescale', String(plan.timescale), '-f', 'mp4', '-y', cooked);
    await runFFmpeg(args);
    prepared[i] = cooked;
  }
  // concat 合并（统一 timescale + in-band SPS/PPS(avc3)，播放器 seek 到任意段不乱码；对照 juku-backend）
  report(62, '合并分集');
  const listFile = safeJoin(workDir, 'inputs.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const f of prepared) lines.push(`file '${String(f).replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listFile, lines.join('\n') + '\n');
  const concatArgs = ['-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy',
    '-video_track_timescale', String(plan.timescale), '-movflags', '+faststart'];
  // h264/hevc 产物一律 avc3/hev1（in-band SPS/PPS）：concat 后播放器 seek 到任何段都按帧内参数解码，杜绝快进花屏/乱码
  if (majority.videoCodec === 'h264') concatArgs.push('-tag:v', 'avc3');
  else if (majority.videoCodec === 'hevc') concatArgs.push('-tag:v', 'hev1');
  concatArgs.push('-y', outputPath);
  await runFFmpeg(concatArgs);
  report(100, '合并完成');
}

// ---- 任务执行 ----
function startTask(task) {
  if (task.status !== 'queued') return;
  task.status = 'downloading';
  task.progress = { phase: 'downloading', episode: 0, total: task.episodes.length, percent: 0, detail: '准备下载' };
  touch(task);
  runTask(task).catch(err => {
    if (task.status === 'canceled') return;
    task.status = 'failed';
    task.error = err && err.message ? err.message : String(err);
    task.progress.percent = 0;
    touch(task);
    flushStore(true);
  });
}

async function runTask(task) {
  const dir = safeJoin(DOWNLOAD_DIR, 'work_' + task.id);
  const workDir = safeJoin(dir, '.merge-work');
  fs.mkdirSync(workDir, { recursive: true });
  const outName = `${sanitizeName(task.title)}_全${task.episodes.length}集.mp4`;
  const outputPath = safeJoin(DOWNLOAD_DIR, outName);

  // 下载阶段（并发 N 集）
  const queue = task.episodes.map((ep, idx) => ({ ep, idx }));
  const headersFor = ep => ep.key
    ? { 'User-Agent': HONGGUO_VIDEO_UA, Referer: HONGGUO_REFERER, 'Accept-Encoding': 'identity' }
    : { 'User-Agent': BROWSER_UA, 'Accept-Encoding': 'identity' };
  const signal = { aborted: false };

  const workers = [];
  let next = 0;
  let downloaded = 0;
  const fileSizes = new Array(queue.length).fill(0);

  for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
    workers.push((async () => {
      while (!signal.aborted) {
        const item = queue[next++];
        if (!item) break;
        const { ep, idx } = item;
        const plainFile = safeJoin(dir, `ep${String(idx + 1).padStart(3, '0')}.mp4`); // 明文分集
        task.progress.episode = idx + 1;
        task.progress.detail = `下载第 ${idx + 1}/${queue.length} 集`;
        touch(task);
        let attempt = 0;
        while (attempt <= RETRIES && !signal.aborted) {
          try {
            const started = Date.now();
            if (ep.key) {
              // 红果 CENC-AES-CTR：完整下载密文后由 ffmpeg -decryption_key 本地解密（与 juku-backend 一致，
              // ffmpeg mov demuxer 原生支持 CENC，产物为标准明文 MP4；避免对不支持 Range 的服务器直连拉流）
              const rawFile = safeJoin(dir, `ep${String(idx + 1).padStart(3, '0')}.enc`);
              task.progress.detail = `下载第 ${idx + 1} 集`;
              touch(task);
              await downloadFile(ep.url, rawFile, headersFor(ep), received => {
                if (signal.aborted) return;
                task.progress.percent = Math.min(98, Math.round((downloaded + Math.min(1, received / 1e8)) / queue.length * 100));
                touch(task);
              }, signal);
              task.progress.detail = `解密第 ${idx + 1} 集`;
              touch(task);
              try {
                await runFFmpeg(['-decryption_key', ep.key, '-i', rawFile, '-c', 'copy', '-f', 'mp4', '-y', plainFile]);
              } finally {
                fs.rmSync(rawFile, { force: true });
              }
            } else {
              const rawFile = safeJoin(dir, `ep${String(idx + 1).padStart(3, '0')}.enc`);
              await downloadFile(ep.url, rawFile, headersFor(ep), received => {
                if (signal.aborted) return;
                task.progress.percent = Math.min(98, Math.round((downloaded + Math.min(1, received / 1e8)) / queue.length * 100));
                touch(task);
              }, signal);
              fs.renameSync(rawFile, plainFile);
            }
            const size = fs.statSync(plainFile).size;
            fileSizes[idx] = size;
            downloaded++;
            task.progress.percent = Math.min(98, Math.round(downloaded / queue.length * 100));
            task.progress.detail = `已下载 ${downloaded}/${queue.length} 集`;
            touch(task);
            if (Date.now() - started > REDOWNLOAD_TIMEOUT_MS) throw new Error('播放地址超时失效，请重新提交');
            break;
          } catch (err) {
            fs.rmSync(safeJoin(dir, `ep${String(idx + 1).padStart(3, '0')}.enc`), { force: true });
            fs.rmSync(plainFile, { force: true });
            attempt++;
            if (attempt > RETRIES) throw new Error(`第 ${idx + 1} 集下载失败: ${err.message}`);
            await new Promise(r => setTimeout(r, 1500 * attempt));
          }
        }
      }
    })());
  }
  await Promise.all(workers);
  signal.aborted = true;
  if (task.status === 'canceled') return;
  if (downloaded < queue.length) throw new Error(`仅成功下载 ${downloaded}/${queue.length} 集，任务中止`);

  // 合并阶段
  task.status = 'merging';
  task.progress.phase = 'merging';
  task.progress.percent = 98;
  task.progress.detail = '开始合并';
  touch(task);
  const files = queue.map((_, i) => safeJoin(dir, `ep${String(i + 1).padStart(3, '0')}.mp4`));
  await mergeEpisodes(files, outputPath, workDir, (percent, detail) => {
    task.progress.percent = percent;
    task.progress.detail = detail;
    touch(task);
  });
  if (task.status === 'canceled') return;

  // 清理分集与中间文件
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  task.status = 'done';
  task.output = outputPath;
  task.progress = { phase: 'done', episode: queue.length, total: queue.length, percent: 100, detail: '完成' };
  touch(task);
  flushStore(true);
}

// ---- 对外 API ----
function createTask({ source, title, seriesId, episodes, owner }) {
  if (!Array.isArray(episodes) || episodes.length === 0) throw new Error('没有可下载的分集');
  if (episodes.length > 200) throw new Error('单次下载最多 200 集');
  for (const ep of episodes) {
    if (!ep || !/^https?:\/\//.test(String(ep.url || ''))) throw new Error('分集播放地址无效');
    if (ep.key && !/^[0-9a-f]{32}$/i.test(String(ep.key))) throw new Error('分集内容密钥无效');
  }
  const id = crypto.randomBytes(8).toString('hex');
  const task = {
    id, source: source === 'huangguo' ? 'huangguo' : 'hongguo',
    title: sanitizeName(title), seriesId: String(seriesId || ''),
    episodes: episodes.map((ep, i) => ({ index: i + 1, url: String(ep.url), key: ep.key ? String(ep.key) : '' })),
    status: 'queued', owner: String(owner || ''), output: '',
    progress: { phase: 'queued', episode: 0, total: episodes.length, percent: 0, detail: '排队中' },
    createdAt: Date.now(), updatedAt: Date.now(), error: '',
  };
  tasks[id] = task;
  touch(task);
  flushStore(true);
  startTask(task);
  return publicTask(task);
}

function publicTask(t) {
  const p = t.progress || {};
  const total = p.total || t.episodes.length || 0;
  const done = p.episode || 0;
  return {
    id: t.id, source: t.source, title: t.title, seriesId: t.seriesId, status: t.status,
    output: t.output, progress: t.progress, error: t.error,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    episodeCount: t.episodes.length, owner: t.owner,
    percent: p.percent || (t.status === 'done' ? 100 : 0),
    detail: p.detail || (t.status === 'done' ? '完成' : ''),
    doneCount: t.status === 'done' ? t.episodes.length : done,
    totalCount: total,
  };
}
function listTasks(owner, isAdmin) {
  const all = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  return (isAdmin ? all : all.filter(t => !t.owner || t.owner === owner)).map(publicTask);
}
function getTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return null;
  if (!isAdmin && t.owner && t.owner !== owner) return null;
  return publicTask(t);
}
function deleteTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return false;
  if (!isAdmin && t.owner && t.owner !== owner) return false;
  t.status = 'canceled';
  t.error = '已取消';
  touch(t);
  const dir = safeJoin(DOWNLOAD_DIR, 'work_' + id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    if (t.output && fs.existsSync(t.output)) fs.rmSync(t.output, { force: true });
  } catch { /* ignore */ }
  delete tasks[id];
  flushStore(true);
  return true;
}
function ensureDirs() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
function status() {
  ensureDirs();
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000 });
  const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 10_000 });
  return {
    downloadDir: DOWNLOAD_DIR,
    writable: (() => { try { fs.accessSync(DOWNLOAD_DIR, fs.constants.W_OK); return true; } catch { return false; } })(),
    ffmpeg: ffmpeg.status === 0, ffprobe: ffprobe.status === 0,
    tasks: Object.keys(tasks).length,
  };
}

loadTasks();
ensureDirs();

module.exports = { createTask, listTasks, getTask, deleteTask, status, DOWNLOAD_DIR };
