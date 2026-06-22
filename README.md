# sakana-cli

Codex CLI 風に Sakana Fugu と対話するためのNode.js CLIです。Pythonは不要です。

## Requirements

- Node.js 22+

## Install

GitHubから直接インストール:

```bash
npm install -g github:YuK1Game/sakana-cli
```

ローカルからインストール:

```bash
cd /home/ubuntu/projects/sakana-cli
npm install -g .
```

インストール後、どのプロジェクトからでも起動できます。

```bash
sakana
```

開発中にこのディレクトリへリンクしたい場合:

```bash
cd /home/ubuntu/projects/sakana-cli
npm link
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

CLIを最新版に更新:

```bash
sakana update
```

実行されるnpmコマンドだけ確認:

```bash
sakana update --dry-run
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
@src/main.js このコードをレビューして
```

## Development

```bash
npm run check
```
