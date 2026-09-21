# Jev Playground

Jev（TypeSafe AI）を使った実験・サンプルプロジェクトをまとめたリポジトリです。

## プロジェクト

- [PDF Semantic Finder](projects/pdf-semantic-finder/README.md): PDF内の文章を自然言語で検索し、該当箇所をハイライトするWebアプリ。React・TypeScript・PDF.js・Cloudflare Workersを使用しています。

## ローカルで起動

```bash
cd projects/pdf-semantic-finder
npm install
cp .dev.vars.example .dev.vars
```

意味検索を利用するには、`.dev.vars`に`TYPESAFE_API_KEY`を設定します。

```bash
npm run dev
```

起動後、http://localhost:5173 を開きます。

ビルド・テスト・デプロイの詳細は、[プロジェクトのREADME](projects/pdf-semantic-finder/README.md)を参照してください。
