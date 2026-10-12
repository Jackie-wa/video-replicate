#!/usr/bin/env node
/**
 * video-replicate.mjs — 导演级高精拉片与AI视频复刻引擎
 * 
 * 核心设计原则：
 * 1. 杜绝漏刀：多阶场景检测（低阈值初筛 + 长镜头密集帧差扫描），彻底消灭同色调切镜、正反打跳切盲区。
 * 2. 杜绝抽帧黑洞：自适应多点采样（起手帧 + 动作峰值/中间帧 + 收尾帧），长镜头必抽中间动作转移。
 * 3. 导演思维升维：提取构图几何（一点透视、深焦、树洞、镜面反射）、空间图层（玻璃隔断、剪影过肩OTS）、舞台调度与微表情。
 * 4. 纯净电影级提示词生成：分时段（30s等分）、声画解耦（台词口型与画外音分离）、无假字幕假转场。
 * 
 * 零依赖：Node 18+ 原生标准库 + ffmpeg/ffprobe
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const shotNo = (i) => `S${String(i + 1).padStart(2, '0')}`;

function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v == null || v.startsWith('--') ? true : v;
}

function flags(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

/** 探测视频元信息 */
export function probe(video) {
  const out = run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate',
    video,
  ]);
  const j = JSON.parse(out);
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`${video} 里没有视频流`);
  const [num, den] = String(v.r_frame_rate ?? '0/1').split('/').map(Number);
  const width = v.width ?? 0;
  const height = v.height ?? 0;
  return {
    durationSeconds: r2(Number(j.format?.duration ?? 0)),
    fps: den ? r2(num / den) : 0,
    width,
    height,
    aspect: width && height ? `${width}:${height}` : '',
    codec: v.codec_name ?? '',
    hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

/** 
 * 多阶场景切点检测（防漏刀核心算法）
 * 1. 基础场景差分：阈值设定为 0.22（低于默认的 0.3，捕捉同色系正反打）
 * 2. 密集体检：对所有大于 2.2 秒的区间进行二次细粒度差分扫描
 */
export function detectCutsMultiPass(video, duration, threshold = 0.22, minShot = 0.35) {
  // Pass 1: 低阈值 ffmpeg 场景检测
  const out1 = run('ffmpeg', [
    '-v', 'error', '-i', video, '-an',
    '-vf', `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
    '-f', 'null', '-',
  ]);
  const rawCuts = [];
  for (const line of out1.split('\n')) {
    const m = /pts_time:([0-9.]+)/.exec(line);
    if (m) {
      const t = r2(Number(m[1]));
      if (t > 0 && t < duration) rawCuts.push(t);
    }
  }

  // 整理第一遍切点
  let sorted = [...new Set(rawCuts)].sort((a, b) => a - b);
  const bounds = [0, ...sorted, duration];

  // Pass 2: 对大于 2.4 秒的区间进行密集扫描（采样率 4Hz）
  const extraCuts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const span = end - start;
    if (span >= 2.4) {
      // 密集提取帧间差分
      try {
        const outDiff = run('ffmpeg', [
          '-v', 'error', '-ss', String(start), '-to', String(end), '-i', video, '-an',
          '-vf', `fps=4,scale=64:36,tblend=all_mode=difference,signalstats,metadata=print:file=-:key=lavfi.signalstats.YAVG`,
          '-f', 'null', '-',
        ]);
        let idx = 0;
        for (const line of outDiff.split('\n')) {
          const m = /signalstats\.YAVG=([0-9.]+)/.exec(line);
          if (m) {
            const val = Number(m[1]);
            const currTime = r2(start + idx * 0.25);
            // 如果在片段中间突然出现显著峰值（> 15.0）且距离边界大于 minShot
            if (val > 15.0 && (currTime - start) >= minShot && (end - currTime) >= minShot) {
              extraCuts.push(currTime);
            }
            idx++;
          }
        }
      } catch (err) {
        // pass
      }
    }
  }

  // 合并并去重
  const allCuts = [...new Set([...rawCuts, ...extraCuts])].sort((a, b) => a - b);

  // 过滤过近切点
  const finalBounds = [0];
  for (const t of allCuts) {
    if (t - finalBounds[finalBounds.length - 1] >= minShot) {
      finalBounds.push(t);
    }
  }
  if (duration - finalBounds[finalBounds.length - 1] < minShot && finalBounds.length > 1) {
    finalBounds.pop();
  }
  finalBounds.push(duration);

  return finalBounds;
}

/** 生成种子分镜数据 */
export function buildSeed(videoPath, title = '') {
  const meta = probe(videoPath);
  const bounds = detectCutsMultiPass(videoPath, meta.durationSeconds);
  const shots = [];

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = r2(bounds[i]);
    const end = r2(bounds[i + 1]);
    const sec = r2(end - start);
    shots.push({
      id: shotNo(i),
      start,
      end,
      seconds: sec,
      size: '',          // 景别
      category: '',      // 类别 (主体/反应/对话/转场/特写)
      camera: '',        // 运镜 (固定/推/拉/低角贴地跟拍/过肩反打/镜中反射)
      perspective: '',   // 导演视听几何 (一点透视/树洞透视/深焦纵深/双层玻璃隔断)
      staging: '',       // 舞台演员调度 (金字塔抱团/朝拜举碗/剪影过肩/对坐)
      acting: '',        // 微表情与动作 (墨镜滑落/瞳孔地震/死鱼眼定格/大颠勺)
      audioRelation: '', // 声画关系 (同期口型 / 画外音V.O. / 纯环境音)
      frame: '',         // 画面描述
      dialogue: '',      // 台词
    });
  }

  return {
    source: resolve(videoPath),
    title: title || basename(videoPath),
    meta,
    totalShots: shots.length,
    shots,
  };
}

/** 
 * 多点自适应抽帧（彻底消灭中间黑洞）
 * <= 1.5s: 2帧 (a: 15%, b: 85%)
 * 1.5s ~ 3.5s: 3帧 (a: 12%, m: 50% 核心动作, b: 88%)
 * > 3.5s: 4帧 (a: 10%, m1: 35%, m2: 65%, b: 90%)
 */
export function extractAdaptiveFrames(doc, videoPath, outDir = 'frames', width = 480) {
  mkdirSync(outDir, { recursive: true });
  let count = 0;
  const manifest = [];

  for (const s of doc.shots) {
    const start = Number(s.start);
    const end = Number(s.end);
    const span = end - start;

    let picks = [];
    if (span <= 1.5) {
      picks = [
        ['a', start + span * 0.15],
        ['b', start + span * 0.85],
      ];
    } else if (span <= 3.5) {
      picks = [
        ['a', start + span * 0.12],
        ['m', start + span * 0.50],
        ['b', start + span * 0.88],
      ];
    } else {
      picks = [
        ['a', start + span * 0.10],
        ['m1', start + span * 0.35],
        ['m2', start + span * 0.65],
        ['b', start + span * 0.90],
      ];
    }

    const shotFrames = [];
    for (const [tag, t] of picks) {
      const filename = `${s.id}_${tag}.jpg`;
      const outPath = join(outDir, filename);
      try {
        run('ffmpeg', [
          '-v', 'error', '-y', '-ss', String(r2(t)), '-i', videoPath,
          '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', outPath,
        ]);
        shotFrames.push({ tag, file: filename, time: r2(t) });
        count++;
      } catch (e) {
        // skip
      }
    }
    manifest.push({ id: s.id, frames: shotFrames });
  }

  return { count, manifest };
}

/** 生成全景大联系表（Contact Sheet） */
export function buildContactSheets(frameDir, outDir = 'sheets', cols = 6, rows = 6) {
  mkdirSync(outDir, { recursive: true });
  // 读取所有 jpg 并自然排序
  const files = (existsSync(frameDir) ? readdirSync(frameDir) : [])
    .filter((f) => f.endsWith('.jpg'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  if (!files.length) return [];

  const perSheet = cols * rows;
  const resultSheets = [];

  for (let i = 0; i < files.length; i += perSheet) {
    const batch = files.slice(i, i + perSheet);
    const listFile = join(outDir, `.list_${i}.txt`);
    const content = batch.map((f) => `file '${resolve(frameDir, f).replace(/\\/g, '/')}'`).join('\n');
    writeFileSync(listFile, content, 'utf8');

    const sheetName = `sheet_${String(Math.floor(i / perSheet) + 1).padStart(2, '0')}.jpg`;
    const outSheetPath = join(outDir, sheetName);

    try {
      run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-filter_complex', `scale=320:-2,tile=${cols}x${rows}:padding=4:margin=4:color=black`,
        '-frames:v', '1', '-q:v', '3', outSheetPath,
      ]);
      resultSheets.push(outSheetPath);
    } finally {
      if (existsSync(listFile)) rmSync(listFile, { force: true });
    }
  }

  return resultSheets;
}

/** 诊断工具：扫描潜在漏切长镜头 */
export function auditLongShots(doc, threshold = 2.5) {
  const warnings = [];
  for (const s of doc.shots) {
    if (s.seconds >= threshold) {
      warnings.push({
        id: s.id,
        span: `${s.start}s - ${s.end}s`,
        seconds: s.seconds,
        hint: `时长超过 ${threshold} 秒，可能包含未拆开的正反打或动作切换，建议检查中间帧！`,
      });
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* CLI 入口                                                           */
/* ------------------------------------------------------------------ */
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
video-replicate — 导演级高精拉片与AI视频复刻 CLI

用法:
  node video-replicate.mjs seed <视频路径> [--out shots.json] [--title "标题"]
      执行防漏刀双阶场景检测，生成初始 shots.json

  node video-replicate.mjs frames <shots.json> --video <视频路径> [--dir frames] [--width 480]
      执行自适应多点抽帧（短镜起收两帧，中长镜三至四帧，杜绝动作盲区）

  node video-replicate.mjs sheet [--dir frames] [--out sheets] [--cols 6] [--rows 6]
      将抽取的关键帧拼装为全景密集体检联系表

  node video-replicate.mjs audit <shots.json> [--thresh 2.5]
      快速筛查潜在漏刀的长镜头

  node video-replicate.mjs recut <shots.json> --split <秒数> [--merge <秒数>]
      精确补刀与并刀，重新编号对齐时间轴
`);
    process.exit(0);
  }

  if (cmd === 'seed') {
    const video = args[1];
    if (!video) throw new Error('请指定视频文件路径');
    const out = flag(args, '--out', 'shots.json');
    const title = flag(args, '--title', '');
    console.log(`[seed] 开始对 ${video} 执行高精度双阶切点检测...`);
    const doc = buildSeed(video, title);
    writeFileSync(out, JSON.stringify(doc, null, 2), 'utf8');
    console.log(`[seed] 检测完成！共切出 ${doc.totalShots} 镜，已保存至 ${out}`);
    const audits = auditLongShots(doc, 2.5);
    if (audits.length) {
      console.log(`[seed 提醒] 发现 ${audits.length} 个长镜头（>2.5s），请使用 frames 多点抽帧检查是否有漏切。`);
    }
    return;
  }

  if (cmd === 'frames') {
    const jsonPath = args[1];
    if (!jsonPath) throw new Error('请指定 shots.json 路径');
    const video = flag(args, '--video');
    if (!video) throw new Error('请提供 --video <视频路径>');
    const dir = flag(args, '--dir', 'frames');
    const width = Number(flag(args, '--width', 480));
    const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
    console.log(`[frames] 开始自适应多点抽帧至 ${dir}/ ...`);
    const { count } = extractAdaptiveFrames(doc, video, dir, width);
    console.log(`[frames] 完成！共抽取 ${count} 张多角度动作与微表情关键帧。`);
    return;
  }

  if (cmd === 'sheet') {
    const dir = flag(args, '--dir', 'frames');
    const out = flag(args, '--out', 'sheets');
    const cols = Number(flag(args, '--cols', 6));
    const rows = Number(flag(args, '--rows', 6));
    console.log(`[sheet] 正在生成联系表至 ${out}/ ...`);
    const sheets = buildContactSheets(dir, out, cols, rows);
    console.log(`[sheet] 生成完毕：共输出 ${sheets.length} 张大图联系表。`);
    return;
  }

  if (cmd === 'audit') {
    const jsonPath = args[1];
    if (!jsonPath) throw new Error('请指定 shots.json 路径');
    const thresh = Number(flag(args, '--thresh', 2.5));
    const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const audits = auditLongShots(doc, thresh);
    console.log(`[audit] 筛查长于 ${thresh}s 的镜头:`);
    console.table(audits);
    return;
  }

  console.error(`未知命令: ${cmd}，请使用 --help 查看帮助。`);
  process.exit(1);
}

main();
