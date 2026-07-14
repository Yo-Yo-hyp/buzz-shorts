# BUZZ SHORTS

登録者数に対して再生数が異常に伸びているYouTube Shortsだけを、
縦スクロールフィードで見られるサイト。

```
buzz-shorts/
├── index.html              ← サイト本体
├── manifest.json            ← PWA設定（ホーム画面に追加するため）
├── sw.js                     ← サービスワーカー（オフライン対応）
├── icons/                    ← PWA用アイコン各サイズ
├── data/
│   └── shorts.json          ← 表示するデータ（フロントはここを読むだけ）
├── fetch-shorts.mjs          ← YouTube Data APIからデータを集めるスクリプト
└── .github/workflows/
    └── update-data.yml       ← 定期実行してshorts.jsonを自動更新するワークフロー
```

## 0. 今回追加した機能

- **PWA化**: スマホのブラウザで開いて「ホーム画面に追加」すると、アプリのように起動できる（要HTTPS。GitHub Pages等にデプロイすれば自動で対応）
- **マイフィード**: 初回アクセス時に好きなジャンルを選ぶモーダルが出て、選んだジャンルだけのフィード「📌マイフィード」が作られる。⚙アイコンから後で変更可能
- **クリップ**: 各動画の左上🔖アイコンで「あとで見る」リストに保存。「🔖クリップ」タブで一覧表示（localStorage保存）
- **観測ストリーク**: 毎日アクセスすると連続日数が記録され、🔥バッジに表示。3日・7日・14日・30日で称号がアップする
- **並び替え**: 右上の⚡アイコンをタップで「急上昇順 → 新着順 → 再生数順」を切り替え

## 1. 動作確認（ローカル）

`index.html` は `fetch('data/shorts.json')` を呼ぶので、
`file://` で直接開くとブラウザのセキュリティ制限で読み込めない。
簡易サーバーを立てて確認する。

```bash
cd buzz-shorts
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

今入っている `data/shorts.json` はサンプルデータ（既存の有名な動画IDを使ったダミー）。
UI・スクロール・言語切り替え・サウンド切り替えの動作確認用なので、
実データに差し替えるまでの仮データとして扱ってOK。

## 2. YouTube Data APIキーの取得

1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成
2. 「APIとサービス」→「ライブラリ」から **YouTube Data API v3** を有効化
3. 「認証情報」→「APIキーを作成」でキーを発行
4. （推奨）キーに「YouTube Data API v3のみ」の制限をかけておく

無料枠は1日10,000ユニット。`fetch-shorts.mjs` は1回の実行で
ジャンル数 × 100ユニット（search.list）＋数ユニット（videos.list / channels.list）
を消費するので、現状の8ジャンル構成なら1回あたり約850ユニット。
1日4回（6時間ごと）でも余裕がある。

## 3. データ収集スクリプトを試す

```bash
cd buzz-shorts
YOUTUBE_API_KEY=あなたのAPIキー node fetch-shorts.mjs
```

実行すると `data/shorts.json` が実データで上書きされる。
ジャンルや検索キーワード、対象期間（`LOOKBACK_HOURS`）、
ジャンルごとの件数（`MAX_PER_GENRE`）は `fetch-shorts.mjs` の上部で調整できる。

## 4. 公開・自動更新（GitHub Pages + GitHub Actions）

1. このフォルダをGitHubリポジトリにpush
2. リポジトリの Settings → Secrets and variables → Actions で
   `YOUTUBE_API_KEY` をSecretとして登録
3. Settings → Pages で公開設定（ブランチを指定するだけでOK）
4. `.github/workflows/update-data.yml` が6時間ごとに自動実行され、
   `data/shorts.json` を最新化してコミットしてくれる

これでサーバー代はGitHub Pagesの無料枠だけで済む構成になる。
VercelやCloudflare Pagesでも同様の構成（GitHub連携＋Actionsで自動デプロイ）が可能。

## 5. 収益化（AdSenseなど）について

- 「他人のコンテンツ（埋め込み動画）だけのサイト」は審査で弾かれやすい傾向がある。
  各動画への一言コメントや、ジャンルごとの簡単な紹介文など、
  オリジナルテキストを足す設計にしておくと良い。
- アクセスが増えても、APIを叩くのはバッチ処理（Actions側）だけなので、
  ユーザー数の増加が直接APIコストに跳ねない構成になっている。

## 6. 今後の調整ポイント（メモ）

- ジャンルや検索キーワードは `fetch-shorts.mjs` の `GENRES` 配列で調整
- 急上昇率の閾値でフィルタしたい場合は、`main()` の手前で
  `growthRatio` によるフィルタを追加すると良い
- 登録者数が非公開のチャンネルは現在除外している
  （急上昇率が計算できないため）
