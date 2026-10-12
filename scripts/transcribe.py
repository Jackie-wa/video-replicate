#!/usr/bin/env python3
"""
transcribe.py — video-replicate 语音识别与时间戳校准引擎
利用本地 faster-whisper-large-v3 模型，对视频/音频提取精确到词级的字幕时间戳
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# 自动发现本地环境与模型
POSSIBLE_DEPS = [
    r'D:\codex-first-demo\.deps\whisper',
]
POSSIBLE_MODELS = [
    r'D:\codex-first-demo\.models\models--Systran--faster-whisper-large-v3\snapshots\edaa852ec7e145841d8ffdb056a99866b5f0a478',
    r'C:\Users\wzp\.cache\huggingface\hub\models--Systran--faster-whisper-large-v3',
]

dep_found = None
for d in POSSIBLE_DEPS:
    if os.path.exists(d):
        sys.path.insert(0, d)
        dep_found = d
        break

model_found = None
for m in POSSIBLE_MODELS:
    if os.path.exists(m):
        model_found = m
        break

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("错误: 未找到 faster_whisper 依赖，请确认 D:\\codex-first-demo\\.deps\\whisper 是否存在。")
    sys.exit(1)

def extract_audio_if_needed(video_path, wav_path):
    if not os.path.exists(wav_path):
        print(f"[transcribe] 正在从 {video_path} 提取 16kHz 单声道音频...")
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-i', str(video_path),
            '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', str(wav_path)
        ], check=True)

def transcribe(audio_path, out_json_path, model_path=model_found):
    print(f"[transcribe] 加载本地 Whisper large-v3 模型: {model_path} ...")
    model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=8, local_files_only=True)
    print(f"[transcribe] 正在执行高精度中文语音转写与词级对齐...")
    segments, info = model.transcribe(
        str(audio_path),
        language='zh',
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False
    )
    result = []
    for seg in segments:
        row = {
            'start': round(seg.start, 2),
            'end': round(seg.end, 2),
            'text': seg.text.strip(),
            'words': [
                {'start': round(w.start, 2), 'end': round(w.end, 2), 'text': w.word}
                for w in (seg.words or [])
            ]
        }
        result.append(row)
        print(f"[{row['start']}s -> {row['end']}s] {row['text']}")

    Path(out_json_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"[transcribe] 转写完成！共对齐 {len(result)} 句台词，已保存至 {out_json_path}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python transcribe.py <音频或视频文件路径> [输出json路径]")
        sys.exit(1)

    input_file = sys.argv[1]
    out_json = sys.argv[2] if len(sys.argv) > 2 else 'transcript-asr.json'

    # 如果是视频文件，先抽音频
    if input_file.lower().endswith(('.mp4', '.mov', '.mkv', '.avi')):
        temp_wav = Path(input_file).with_suffix('.wav')
        extract_audio_if_needed(input_file, temp_wav)
        audio_target = temp_wav
    else:
        audio_target = input_file

    transcribe(audio_target, out_json)
