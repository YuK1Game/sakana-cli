# sakana-cli

Codex CLI 風に Sakana Fugu と対話するためのローカルCLIです。

## Install

```bash
cd /home/ubuntu/projects/sakana-cli
python3 -m venv .venv
.venv/bin/pip install -e .
mkdir -p ~/.local/bin
ln -sf /home/ubuntu/projects/sakana-cli/.venv/bin/sakana ~/.local/bin/sakana
```

`~/.local/bin` が `PATH` に入っていれば、どのプロジェクトからでも起動できます。

```bash
sakana
```

## API Key

カレントディレクトリまたは親ディレクトリの `.env` から `SAKANA_API_KEY` を読みます。

```env
SAKANA_API_KEY=...
```

シェル環境変数でも使えます。

```bash
export SAKANA_API_KEY=...
```

## Usage

```bash
sakana
sakana --model fugu-ultra
sakana "このプロジェクトの実装方針を整理して"
```

対話中のコマンド:

```text
/help            コマンド一覧
/status          現在の設定
/model NAME      モデル変更: fugu または fugu-ultra
/reset           会話履歴をクリア
/add PATH        ファイルを会話コンテキストに追加
/context         追加済みファイル一覧
/clear-context   追加済みファイルをクリア
/quit            終了
```

プロンプト内で `@path/to/file` と書くと、そのファイル内容を一回だけ添付します。

```text
@src/main.py このコードをレビューして
```

