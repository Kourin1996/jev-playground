# pdf-finder.kourin.jp へのデプロイ

_原典は英語版の [deployment.md](deployment.md) です。この文書はその翻訳であり、食い違いがあれば
英語版が正です。_

このアプリケーションを `pdf-finder.kourin.jp` で一般公開するための手順書です。Cloudflare アカウントと
TypeSafe AI の認証情報を持っている人向けに書いています。

費用が知りたい場合は先に[仕様書 §14.30](spec.md) を読んでください。要約すると、Workers の月額 $5 と
1検索あたり約 $0.004 です。

## 1. 実際にデプロイされるもの

製品の大部分はサーバ上にないので、ここを明確にしておきます。

| 構成要素                                      | 実行場所             | 備考                                 |
| --------------------------------------------- | -------------------- | ------------------------------------ |
| PDFを開く・描画・テキスト抽出・セグメント分割 | 読者のブラウザ       | ファイルはブラウザから出ません       |
| 完全一致検索                                  | 読者のブラウザ       | リクエストを一切発生させません       |
| 意味検索                                      | Worker → TypeSafe AI | クエリと抽出テキストだけが送られます |
| TypeSafe の認証情報                           | Worker secret        | ブラウザには決して届きません         |

つまりデプロイされるのは、静的ファイル一式、約48 KiB の Worker、Durable Object クラス1つ、
rate limit binding 1つだけです。

## 2. 前提条件

**Workers Paid が必須です。** セグメント上限(2,000)の検索は1回の呼び出しで500回のプロバイダ呼び出しを
行い、リトライを含めると最大1,000回になります。Workers Free の subrequest 上限は50で、200セグメントの
文書でも既に超えます。`wrangler.jsonc` は `limits` でこの許容量を宣言しており、このキーは standard usage
model でのみ有効です。したがって Free プランでは**読者の50回目の subrequest ではなく `wrangler deploy`
の時点で失敗します** — 宣言している理由がこれです。

**`kourin.jp` が同じ Cloudflare アカウントのゾーンとして既に存在している必要があります。** ルートは
custom domain として設定しているので、サブドメインのDNSレコードと証明書は Cloudflare が作成・管理します。
保持していないゾーンに対しては実行できません。

**TypeSafe AI の APIキー**と、`.dev.vars.example` に固定されているモデル名。

**wrangler の認証**: `npx wrangler login` の後、`npx wrangler whoami` でアカウントを確認してください。

## 3. 初回デプロイ前

### 3.1 検査を通す

```bash
npm ci
npm run fixtures:sample   # これが無いとスイートは明示的にskipします
npm run verify            # assets + typecheck + 単体テスト + E2E
```

`npm run verify` は2つのサーバを立てます。Vite の開発サーバと、`dist/` をビルドした `wrangler dev`
プレビューです。ヘッダのテストは後者に対して走ります。開発サーバは Cloudflare のアセットルーティングも
`public/_headers` も再現しないからです。

コールドスタート時は両方がビルドと同時に立ち上がるため、まだ処理中の開発サーバを待つブラウザテストが
まれにタイムアウトします。再実行してください。サーバが温まった状態で通れば原因はこれです。本物の失敗は
再現します。

### 3.2 secret を登録する

```bash
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TYPESAFE_MODEL     # 既定以外のモデルを固定する場合のみ
```

`.dev.vars` はローカル開発用で gitignore 対象です。**アップロードはされません**。`wrangler deploy` が
送るのは Worker のエントリポイントと `dist/client` の中身で、`.dev.vars` はビルドされた Worker の隣の
`dist/pdf_finder` にあります。`npx wrangler deploy --dry-run` で確認してください — アップロード対象は
Worker とアセット数だけのはずです。

### 3.3 設定が意図どおりか確認する

```bash
npm run build
npx wrangler deploy --dry-run
```

binding はちょうど3つのはずです:

```
env.SEARCH_BUDGET (SearchBudget)             Durable Object
env.SEARCH_RATE_LIMIT (20 requests/60s)      Rate Limit
env.ASSETS                                   Assets
```

**binding が欠けていてもデプロイは失敗しません。** ローカル開発とテストスイートを binding 無しで
動かせるように、Worker は受付制御の binding を両方とも optional として扱い、`admission_unavailable`
をログに出して処理を続けます。**つまり設定を誤ったデプロイは、黙って制限なしになります。** この確認と
後述の §5.2 がある理由です。

`dist/pdf_finder/wrangler.json` で次も確認してください:

- `"routes": [{"pattern": "pdf-finder.kourin.jp", "custom_domain": true}]`
- `"workers_dev": false` — これが無いと `pdf-finder.<account>.workers.dev` でも到達可能になります。
  誰にも告知していない2つ目の公開オリジンであり、ゾーンのWAFにも分析にも載りません。

## 4. デプロイ

```bash
npm run deploy     # npm run build && wrangler deploy
```

初回デプロイでは `v1` マイグレーションによる Durable Object クラスの作成と、カスタムドメインの
プロビジョニングも行われます。DNSと証明書には数分かかることがあります。

**初回は手元のログイン済み環境から手作業で実行してください。** ホスト名のプロビジョニング、
Durable Object のマイグレーション、そして secret が先に入っていることが前提になる操作であり、
比較できる既知の正常なデプロイがまだ無い段階で CI のトークンにやらせるべきものではありません。
初回が成功し §5 を通過したら、以降のデプロイは §12 で GitHub Actions に渡します。

## 5. デプロイ後の確認

ここはローカルでは一切確認できません。毎回実施し、結果を記録してください。

### 5.1 そもそも動くか

`https://pdf-finder.kourin.jp` を開き、PDFを開き、完全一致検索と意味検索を実行します。そのうえで
ブラウザのコンソールが**空であること**を確認してください。Content-Security-Policy 違反はコンソールに
しか出ませんし、ローカルのプレビューでは実際のアセットパスに対するポリシーを証明できません。

Chrome・Firefox・Safari の3つで実施してください。自動テストは Chromium のみです。

### 5.2 制限が本当に効いているか

**クライアント単位のレート制限。** 1台から1分間に21回検索してください。21回目は `Retry-After` 付きの
`429` を返し、UIがそれを表示し、**自動で再試行しない**はずです。

拒否されない場合、binding が欠けておりエンドポイントは無制限です。その場合 Worker は
`{"event":"admission_unavailable","gate":"rate_limit"}` をログに出します。`npx wrangler tail` で
確認してください。

この制限は Cloudflare のロケーション単位で評価されるため、アカウントではなく1クライアントを縛るものです。
1箇所から試すことだけが、この制限の意味のある試験になります。

**プロバイダ予算。** アカウント全体のトークン予算が埋まると Durable Object が検索を拒否します。
`{"event":"admission_unavailable","gate":"provider_budget"}` がログに**出ていない**ことを確認して
ください。負荷試験なしにこの拒否を引き起こす簡単な方法はありません。

**subrequest の許容量。** セグメント上限近くの文書 — `npm run fixtures:sample` が生成する
`sample-near-limit-ja.pdf`(1,872セグメント) — を検索し、途中で失敗せず完了することを確認してください。
所要時間も記録します。ローカルでは5.2〜5.5秒ですが、デプロイ後のスループットは別物です。Cloudflare は
レスポンスヘッダ待ちの接続数も制限しているためです。

**実際の subrequest の数値を Cloudflare の公開情報で確認してください。** このリポジトリは1,100を
宣言しています。Paid プランの公開値は1,000とも10,000とも示されてきました。1,000だとすると、上限規模の
検索にリトライが乗ったとき、ちょうど境界に乗ります。

### 5.3 ヘッダが届いているか

```bash
curl -sD - -o /dev/null https://pdf-finder.kourin.jp/ | grep -i 'content-security-policy\|x-frame'
```

`/assets/` 配下のハッシュ付きアセットでも同じ確認をしてください。これらは **Worker を経由せずに**
Cloudflare のアセットルータが返すため、コードではなく `public/_headers` が担当しています。別の仕組みで
あり、黙って欠けている可能性が高いのはこちらです。

## 6. ロールバック

```bash
npx wrangler deployments list
npx wrangler rollback [version-id]
```

Durable Object のマイグレーションはロールバックでは戻りません。このアプリケーションはそれに依存して
いません。オブジェクトはメモリ上のカウンタだけを持ち、保存データを持たないからです。

## 7. 運用

**ログ** — `npx wrangler tail`。§10 により、ログにはファイル名・クエリ・抽出テキスト・文書内容は
一切含まれません。含まれるのは所要時間、セグメント数とバッチ数、モデルID、プロバイダのトークン使用量、
エラーコードです。§10 を読み直さずに項目を増やさないでください。

**費用** — 変動するのは TypeSafe 側で、おおよそ `セグメント数 × 600 × $42/10⁹` です。Cloudflare は
約30万検索/月まで $5 固定です。内訳は §14.30 にあります。

**注視すべきは費用ではありません。** プロバイダ予算は単一のグローバル Durable Object にあり、
world 全体のすべての検索が1インスタンスを直列に通ります。コストになるずっと前にレイテンシの
ボトルネックと単一障害点になります。トラフィックが増えたとき最初に見直すべき箇所です。

## 8. 対応できていないこと(明示しておきます)

免責ではなく、正直な一覧です。いずれも公開デプロイにおける実際の欠落です。

- **キーボード操作とスクリーンリーダー対応が不完全です。** 検索モードの切り替えは自前の radio group で
  矢印キー移動も roving tab stop もなく、検索の進捗・完了・不一致・エラーを知らせる live region も
  ありません。目で見える変化が、スクリーンリーダー利用者には伝わりません。公開前レビューの R16 です。
- **ストリームのキャンセルが部分的です。** 読者が離脱するとストリームは閉じますが、実行中のプロバイダ
  呼び出しは中断されず、決定的に失敗したバッチも兄弟の完了を待ちます。
- **1検索あたりのCPU時間を測っていません。** 費用モデルは寛大に100msと仮定しています。それでも込みの
  許容量で30万検索/月をまかなうので結論は変わりませんが、この数値自体は仮定です。
- **ポリシーの `'wasm-unsafe-eval'` は予防的なものです。** このリポジトリのどのfixtureも PDF.js の
  WebAssembly 経路を通らないため、この指示を外してもスイートは緑のままです。読者のPDFがそれを必要とする
  画像コーデックを含む可能性があるので残しています。
- **テストは Chromium のみです。** Firefox と Safari は §5.1 の手作業だけが確認手段です。
- **§7 の関連度しきい値は仮説です。** held-out 評価セットが示したのは「仕組みが意図したパッセージに
  到達する」(26/26、miss 0、誤検出 0)ことであって、0.65 と 0.35 が正しい数値だということではありません。
- **敵対的入力の試験をしていません。** モデルを狙った指示を含むPDFは、このデプロイに対して試していません。
  各質問で state を untrusted と明示しているため攻撃面は小さくなっていますが、ランキングを操作できない
  ことを示したわけではありません。

## 9. デプロイ可能性の確認結果

2026-09-21 時点のツリーに対して実施。すべて `npx wrangler deploy --dry-run` で再現できます。

| 確認項目                                              | 結果                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Worker のバンドルサイズ                               | 47 KiB(gzip 16 KiB)— 上限に対して十分小さい                  |
| バンドル内の Node 組み込みモジュール                  | なし。`nodejs_compat` フラグは不要                           |
| 静的アセット                                          | 208ファイル、最大 1.26 MB(PDF.js のワーカー)                 |
| `compatibility_date`                                  | 2026-09-20、未来日付ではない                                 |
| binding の解決                                        | `SEARCH_BUDGET`・`SEARCH_RATE_LIMIT`・`ASSETS`               |
| エントリポイントからの Durable Object クラスの export | あり                                                         |
| アップロードに含まれる secret                         | なし。`.dev.vars` はアセットルートの外、エントリポイントの外 |

デプロイを妨げるものはありません。残るのは §2 のアカウント側の作業と §5 の確認で、どちらも
dry run では代替できません。

## 10. 広く告知する前に

上記のゲートは「デプロイが存在すること」に対するものです。多くの人に案内する前に:

1. R16 を解消するか、キーボード操作にまだ対応していないと明記してください。
2. held-out 評価セットを localhost ではなくデプロイ先に対して実行してください。
3. 複数人が同時に検索する実際の並行性のもとで、プロバイダ予算の挙動を観察してください。
4. TypeSafe の残高が尽きたときにどうなるかを決めてください。現状は検索エラーとして表面化します。
   これは正しい挙動ですが、読者にとって有用なことは何も伝えていません。

## 11. リポジトリの公開

デプロイとは別の話で、両者は独立しています。サイトを公開してリポジトリを非公開にすることも、その逆も
できます。ここはリポジトリ側の手順です。何を監査し何を結論としたかは `README.md` の
"Publishing this repository" にあります。

### 11.1 前回の監査を信用せず、もう一度実行する

監査はその時点のツリーに対する記述であり、ツリーはその後動いています。

```bash
git ls-files | xargs grep -rlI -e 'sk-' -e 'BEGIN .*PRIVATE KEY' -e 'Bearer ' 2>/dev/null
git ls-files | grep -iE 'dev\.vars$|\.env$'          # .dev.vars.example 以外は出ないはず
git log --all --oneline -S"$(sed -n 's/^TYPESAFE_API_KEY=//p' .dev.vars)" -- 2>/dev/null
git status --short --ignored | grep -E '^!!' | head   # p/, docs/code-review-*, UNTITLED.md を確認
```

重要かつ最も間違えやすいのは3番目です。作業ツリーではなく全コミットを検索します。求める結果は
「何も出ない」ことなので、**空の結果を信じる前に検索自体が機能することを確かめてください** —
コミット済みだと分かっている文字列で一度実行し、一致することを見ます。黙って何も一致しない
スキャナは、きれいなリポジトリと見分けがつきません。

`.dev.vars`・`p`・`docs/code-review-*.md`・`UNTITLED.md` は untracked ではなく gitignore 済みです。
この区別が要点で、untracked なファイルは `git add -A` 1回で公開されますし、
`docs/code-review-*.md` はこのデプロイの未解決の弱点の一覧です。

### 11.2 作業を `main` に載せる

公開したくないものの排除は push の前に行う必要があります。誰かが既に fetch したコミットは
force-push では消えませんし、GitHub は到達不能になったオブジェクトをしばらく SHA 指定で
参照可能なまま保持します。確実な取り消しはリポジトリの削除だけです。

```bash
git switch main
git merge --ff-only review-fixes/segmentation-batching-and-evaluation
git log --oneline -5
```

### 11.3 作成する

```bash
gh repo create Kourin1996/pdf-finder --public --source=. --remote=origin --push
```

`--source=.` は空のリポジトリではなくこの作業コピーから作成し、`--push` は**現在のブランチ**を
push して upstream に設定します。したがって §11.2 のように先に `main` へ切り替えてください。
他のローカルブランチは明示的に push するまでローカルに残ります — 公開するつもりの履歴だけを
1ブランチずつ公開できる、望ましい挙動です。

世間に見せる前に自分で確認したい場合は `--private` で作成して push し、GitHub 上でファイル一覧を
確認してから Settings で可視性を切り替えてください。private → public は簡単ですが、逆方向は
既に fetch されたものを取り消せません。

`package.json` は `"private": true` を持ち `LICENSE` はありません。つまり読めるだけで誰にも権利は
与えていません。これは意図した整合的な立場です — 公開することと OSS にすることは別です。
後からライセンスを付けるかどうかは判断であって、ついでに直すべき見落としではありません。

## 12. GitHub からの自動デプロイ

`.github/workflows/deploy.yml` が、すべての push と pull request で検査を実行し、`main` が動いた
ときにデプロイします。

### 12.1 実行される内容

`npx prettier --check .`、次に `npm run fixtures:sample`(fixture が無いとスイートは明示的に skip し、
skip されたスイートは何も証明しない green です)、次に
`npx playwright install --with-deps chromium`、そして `npm run verify` — assets・typecheck・
単体テスト・E2E。E2E 側は両方のサーバを立ち上げ、§5.3 のヘッダが実際に検証される `wrangler dev`
プレビューもここに含まれます。

そのうえで、`main` への push のときだけ `npm run build && npx wrangler deploy` を実行します。
このリポジトリの lockfile に固定された wrangler を使うので、デプロイするバージョンは検査が
走ったバージョンと同じです。

### 12.2 意図的に実行しないこと

- **secret はアップロードしません。** `TYPESAFE_API_KEY` は `wrangler secret put` で一度設定すれば
  (§3.2)デプロイをまたいで保持され、デプロイはそれを読むことも書き換えることもしません。つまり
  CI トークンが漏れてもコードはデプロイできますが、プロバイダの認証情報は読み出せません。
- **評価セットは実行しません。** `npm run eval` は実際のプロバイダを呼び、実行ごとに費用が
  かかります。意図して手元で実行するコマンドのままにします。
- **§5 は一切自動化していません。** レート制限・プロバイダ予算・デプロイされたヘッダは、
  デプロイ後に実物に対して手作業で確認します。

### 12.3 トークンと、その権限

Cloudflare の **Edit Cloudflare Workers** テンプレートから API トークンを作成してください。
アカウントの Workers Scripts:Edit とゾーンの Workers Routes:Edit を含み、カスタムドメインへの
デプロイに必要な範囲です。対象を当該アカウントと `kourin.jp` ゾーンに限定してください。
テンプレートの現在の権限一覧は、この段落ではなく Cloudflare の公式文書で確認してください。
テンプレートは変わります。

そのうえでリポジトリの Settings → Secrets and variables → Actions に:

```
CLOUDFLARE_API_TOKEN     上記のトークン
CLOUDFLARE_ACCOUNT_ID    npx wrangler whoami
```

public リポジトリでは、fork からの pull request の実行にこれらは渡されません。加えて deploy ジョブ
自体が `github.event_name == 'push' && github.ref == 'refs/heads/main'` で制限されています。
両方に意味があります — pull request がデプロイするのを止めるのは後者、トークンを読むのを止めるのは
前者です。

### 12.4 自動化した後

ロールバック(§6)も確認(§5)も手作業のままです。自動で出ていくデプロイであっても、不特定多数が
見るものを変える行為であることは変わりません。`main` へのマージがリリース判断そのものになったと
考えてください。マージと公開サイトの間に承認ステップを置いていないのは意図的です — 誰も実施しない
ステップは、ステップが無いことより悪いからです。

繰り返し起きうる失敗は §3.1 のコールドスタート競合だけです。ワークフローが CI で E2E を1回だけ
リトライするのは、まさにこの理由のためであり、他の理由のためではありません。2回とも失敗する
テストは本物の失敗です。
