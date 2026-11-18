# spi-camera-solver

iPhoneのカメラでSPIの選択問題を撮影すると画像をバックエンド経由でGemini APIへ自動送信し、正答候補と簡潔な理由を表示する個人専用PWAです。Cloudflare Workers FreeとCloudflare Access Freeを使うと、Macを起動していない状態でもiPhoneのホーム画面から安全に利用できます。

## 主な機能

- 背面カメラを `getUserMedia`（音声なし）で起動し、撮影ボタン押下時に `<canvas>` から静止画を取得します（アプリ自身はシャッター音を鳴らしませんが、OS側の撮影音制約の回避は保証しません）。
- iOSで別アプリへ切り替えたり画面をロックしたりしたあとにカメラが停止した場合は、ページ復帰とトラック終了イベントを検知して自動で再起動を試みます。
- 1回の撮影につき原則1回のAPI呼び出しで設問と全選択肢を読み取り、`gemini-3.8-flash`（Thinking Level `high`）で正答候補・理由・計算問題の検算結果を表示します。
- 判読できない画像は無理に解答せず再撮影を促します。撮影した画像や解答履歴のデータベース保存は行いません。
- Cloudflare Workers公開時は、Cloudflare AccessとWorker内のRS256 JWT署名検証によって許可した本人のメールアドレスだけを通過させます。`ALLOWED_EMAIL`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` のいずれかが未設定の場合はHTTP `403` でアクセスを拒否します。

## 動作環境

- Node.js 20以上（ローカル起動・ビルド・デプロイ作業用）
- Google AI Studio で発行した Gemini API キー
- （外部公開する場合）Cloudflare 無料アカウント（Workers Free と Zero Trust Free）

## ローカル環境でのセットアップ手順

1. リポジトリを取得し、依存パッケージをインストールします。

   ```bash
   git clone https://github.com/haruto20041019-hash/spi-camera-solver.git
   cd spi-camera-solver
   npm install
   ```

2. `.env.example` をコピーして `.env` を作成し、ご自身の `GEMINI_API_KEY` を設定します。

   ```bash
   cp .env.example .env
   ```

   ```dotenv
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_THINKING_LEVEL=high
   PORT=3001
   ```

3. 開発サーバーを起動します。

   ```bash
   npm run dev
   ```

   初回起動時に `scripts/ensure-cert.mjs` が `.cert/` 配下へ自己署名HTTPS証明書を生成し、同じWi-Fi内のiPhoneから接続できるURL（`https://<ローカルIP>:5173`）を表示します。

## Cloudflare Workers Free へのデプロイ手順

以下の手順でご自身のCloudflareアカウントへ無料公開できます。

1. Cloudflareダッシュボードの「Workers & Pages」で `workers.dev` サブドメイン（無料）を有効にします。
2. Cloudflareダッシュボードの「Zero Trust」を「Zero Trust Free」プランで有効化し、Team domain（`<チーム名>.cloudflareaccess.com`）を控えます。
3. 「Workers & Pages」で「Protect all Workers」（または対象のWorker）からCloudflare Accessを「All traffic」で有効にし、ポリシーでご自身のメールアドレスだけを許可します。そのAccessアプリの「Application Audience (AUD) Tag」を控えます。
4. `wrangler.toml` の `[vars]` 欄にご自身の情報を記入します。

   ```toml
   ALLOWED_EMAIL = "your-email@example.com"
   CF_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com"
   CF_ACCESS_AUD = "your-application-aud-tag"
   ```

5. WranglerでCloudflareへログインし、Gemini APIキーをCloudflare Secretsに登録してデプロイします。

   ```bash
   npx wrangler login
   npm run cf:secret:key
   npm run cf:deploy
   ```

   デプロイ完了後に表示される `https://spi-camera-solver.<サブドメイン>.workers.dev` がご自身の専用URLです。`.env` や `wrangler.toml` の認証情報を外部に公開しないようご注意ください。

## iPhoneのホーム画面への追加手順

1. iPhoneのSafariでデプロイ先のURLを開きます。
2. Cloudflare Accessの認証画面が表示されたら、許可したメールアドレスでログインします。
3. Safari下部の共有ボタンから「ホーム画面に追加」をタップして「追加」を選びます。
4. ホーム画面の「SPI解答」アイコンから起動し、カメラへのアクセスを許可して利用を開始します。

## ライセンスと著作権表示

本プロジェクトは MIT License のもとで公開しています。商用利用、改変、再配布が可能です。詳細は [LICENSE](./LICENSE) を参照してください。

背面カメラの取得処理、Canvasによる静止画抽出、Gemini APIの `inlineData` 送信構造は、MIT License で公開されている [gaurav-chhajer/Be-My-Eyes](https://github.com/gaurav-chhajer/Be-My-Eyes)（Copyright (c) [2025] GAURAV CHHAJER）の実装を参考にして構成しました。
