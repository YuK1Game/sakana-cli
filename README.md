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

標準では `~/.sakana/credentials` からAPIキーを読みます。

```bash
mkdir -p ~/.sakana
chmod 700 ~/.sakana
printf 'SAKANA_API_KEY=your_api_key_here\n' > ~/.sakana/credentials
chmod 600 ~/.sakana/credentials
```

次の形式も使えます。

```env
SAKANA_API_KEY=...
```

```text
your_api_key_here
```

シェル環境変数 `SAKANA_API_KEY` は credentials より優先されます。

```bash
export SAKANA_API_KEY=...
```

credentials の場所を変えたい場合:

```bash
export SAKANA_CREDENTIALS_FILE=/path/to/credentials
```

互換性のため、credentials がない場合はカレントディレクトリまたは親ディレクトリの `.env` も fallback として読みます。

## Usage

```bash
sakana
sakana --model fugu-ultra
sakana "このプロジェクトの実装方針を整理して"
```

デフォルトではローカルツールが有効です。モデルは必要に応じて、現在の作業ディレクトリ内でファイル一覧取得、ファイル読み取り、ファイル作成・上書き、コマンド実行を行います。

従来のチャットのみで使う場合:

```bash
sakana --no-tools
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
