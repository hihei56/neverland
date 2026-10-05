"""放送大学の授業音声（CDから取り込んだファイル）を文字起こしして、Claudeで要約するスクリプト。

使い方:
    python summarize.py <音声ファイルまたはフォルダ> [...] [-o 出力フォルダ]

CDはそのままでは読めないので、先にWindows Media Playerなどで
WAV/MP3に取り込んでから、そのファイルかフォルダを指定してください。

各ステップの出力が既にあれば、そのステップはスキップします（途中から再開できる）。
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".wma"}

SUMMARY_PROMPT = """以下は放送大学の授業の文字起こしです（音声認識なので誤変換を含みます）。
受講生が授業を聞かずに内容を把握し、単位認定試験に備えられるように、次の形式の日本語Markdownでまとめてください。

## 一言でいうと
（2〜3文）

## 要点
（授業の流れに沿った箇条書き。重要な定義・数値・人名・年号は落とさない）

## 重要用語
（用語: 1行の説明。誤変換と思われる語は正しい表記に直し、推定である旨を（推定）と付記）

## 試験に出そうなポイント
（択一式で問われそうな論点を5つ程度。紛らわしい対比があれば明記）

## 想定問題
（4択問題を3問。正解と短い解説付き）

文字起こしに無い内容は補わないでください。聞き取れていない・意味が通らない箇所は「不明瞭」と明記してください。"""


def run_ffmpeg(args):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed")


def collect_jobs(inputs):
    """(名前, 入力ファイル) のリストを返す。"""
    jobs = []
    for raw in inputs:
        path = Path(raw)
        if not path.exists():
            sys.exit(f"見つかりません: {path}")
        if path.is_dir():
            for f in sorted(path.rglob("*")):
                if f.suffix.lower() in AUDIO_EXTS:
                    jobs.append((f.stem, f))
        elif path.suffix.lower() == ".cda":
            sys.exit(".cda はCDの目次ファイルで音声ではありません。先にWAV/MP3へ取り込んでください。")
        else:
            jobs.append((path.stem, path))
    return jobs


def extract_audio(src: Path, wav: Path):
    """16kHzモノラルWAVに変換する（Whisperの入力形式）。"""
    try:
        run_ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(wav)])
    except RuntimeError as e:
        wav.unlink(missing_ok=True)
        raise RuntimeError(f"音声を読み込めませんでした: {e}") from e


_whisper_model = None


def transcribe(wav: Path, out_txt: Path, model_name: str):
    global _whisper_model
    from faster_whisper import WhisperModel

    if _whisper_model is None:
        print(f"  Whisperモデル {model_name} を読み込み中（初回はダウンロードあり）...")
        _whisper_model = WhisperModel(model_name, device="auto", compute_type="default")
    segments, info = _whisper_model.transcribe(
        str(wav), language="ja", vad_filter=True, beam_size=5,
    )
    lines = []
    for seg in segments:
        m, s = divmod(int(seg.start), 60)
        lines.append(f"[{m:02d}:{s:02d}] {seg.text.strip()}")
        print(f"\r  文字起こし中... {m:02d}:{s:02d} / {int(info.duration) // 60:02d}分", end="", flush=True)
    print()
    out_txt.write_text("\n".join(lines) + "\n", encoding="utf-8")


def summarize(transcript: str, title: str, model: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=model,
        max_tokens=64000,
        output_config={"effort": "high"},
        # 安全分類器に誤って拒否された場合、サーバー側で推奨モデルに自動で再試行させる
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SUMMARY_PROMPT,
        messages=[{
            "role": "user",
            "content": f"<title>{title}</title>\n<transcript>\n{transcript}\n</transcript>",
        }],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise RuntimeError(f"要約を拒否されました: {message.stop_details}")
    text = "".join(b.text for b in message.content if b.type == "text")
    if message.stop_reason == "max_tokens":
        text += "\n\n（出力上限で途中終了）"
    return text


def main():
    parser = argparse.ArgumentParser(description="放送大学の授業音声を文字起こし→要約する")
    parser.add_argument("inputs", nargs="+", help="音声ファイル、または音声ファイルを含むフォルダ")
    parser.add_argument("-o", "--out", default="output", help="出力フォルダ（既定: output）")
    parser.add_argument("--whisper-model", default="large-v3",
                        help="Whisperモデル。GPUが無く遅い場合は medium や small（既定: large-v3）")
    parser.add_argument("--claude-model", default="claude-opus-5-5", help="要約に使うClaudeモデル")
    parser.add_argument("--no-summary", action="store_true", help="文字起こしまでで止める（APIキー不要）")
    args = parser.parse_args()

    if not args.no_summary and not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        print("注意: ANTHROPIC_API_KEY が未設定です。ant auth login 済みでなければ要約で失敗します。"
              "文字起こしだけなら --no-summary を付けてください。")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = collect_jobs(args.inputs)
    if not jobs:
        sys.exit("処理できるファイルが見つかりませんでした。")
    print(f"{len(jobs)} 件を処理します。")

    failed = []
    for name, src in jobs:
        print(f"\n=== {name} ===")
        wav = out_dir / f"{name}.wav"
        txt = out_dir / f"{name}.transcript.txt"
        md = out_dir / f"{name}.summary.md"
        try:
            if not txt.exists():
                if not wav.exists():
                    print("  音声を抽出中...")
                    extract_audio(src, wav)
                transcribe(wav, txt, args.whisper_model)
                wav.unlink()  # 文字起こしが済んだら大きいWAVは消す
            if not args.no_summary and not md.exists():
                print("  Claudeで要約中...")
                md.write_text(summarize(txt.read_text(encoding="utf-8"), name, args.claude_model),
                              encoding="utf-8")
            print(f"  完了: {md if md.exists() else txt}")
        except Exception as e:  # 1件の失敗で残りを止めない
            print(f"  失敗: {e}")
            failed.append(name)

    if failed:
        sys.exit(f"\n失敗: {', '.join(failed)}")
    print("\nすべて完了しました。")


if __name__ == "__main__":
    main()
