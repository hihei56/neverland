# 放送大学 授業要約ツール

授業DVD/CDの音声 → 文字起こし（Whisper、ローカル実行）→ Claudeで要約（要点・用語・想定問題）

## 準備（初回だけ）
1. Python 3.10以上と ffmpeg をインストール（Windowsなら `winget install ffmpeg`）
2. `pip install -r requirements.txt`
3. Anthropic APIキーを設定: `set ANTHROPIC_API_KEY=sk-ant-...`（macOS/Linuxは `export`）

## 使い方
```
# DVD（ドライブ文字をそのまま指定してよい）
python summarize.py D:\

# CD：先にWindows Media Playerなどで「CDの取り込み」→ WAV/MP3にしてからフォルダ指定
python summarize.py "C:\Users\me\Music\放送大学_心理学"

# 文字起こしだけ（APIキー不要。テキストはClaudeのチャットに貼れば要約できる）
python summarize.py D:\ --no-summary
```
`output/` に `〇〇.transcript.txt`（タイムスタンプ付き全文）と `〇〇.summary.md`（要約）ができます。
途中で止まっても、もう一度実行すれば終わった所から再開します。

## 目安
- 文字起こし: GPU（NVIDIA）ありで1コマ数分。GPUなしで `large-v3` だと1コマ30分〜1時間以上かかるので、`--whisper-model medium` か `small` を推奨（そのぶん誤変換が増える）
- 要約コスト: 1コマ（約1.5万字）あたり数十円程度

## 注意
- **コピーガード(CSS)付きのDVDは読めません。** ガードを外す取り込みは私的使用でも違法（著作権法30条1項2号）なので、このツールでは対応していません。
- 文字起こしや要約は自分の学習用に限ってください。他人への配布やアップロードはNGです。
- 専門用語は誤変換されがちです。試験前には印刷教材で数値・定義を確認してください。
