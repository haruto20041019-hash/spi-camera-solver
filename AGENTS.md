# 開発方針とルール

## 目的

このプロジェクトでは個人専用のSPI問題解答アプリを提供する。iPhoneのカメラでSPIの選択問題を撮影すると画像を自動的にGemini APIへ送信し、正答候補とその理由を表示する。

## 最優先方針

動作するMVPの完成を最優先する。設計や過剰なテストで作業を停滞させず、不要な外部サービスや依存関係を追加しない。利用者は各自1人だけとし、App Store公開、データベース、履歴保存、ユーザー登録機能は実装しない。

## 既存OSSの確認と活用

対象リポジトリのライセンスを確認したうえで、必要な処理だけを流用し、巨大なプロジェクト全体の無理な移植は行わない。

- `github.com/gaurav-chhajer/Be-My-Eyes`（MIT License）は `getUserMedia({ video: { facingMode: 'environment' } })` による背面カメラ取得、`canvas.drawImage` と `toDataURL('image/jpeg')` による静止画抽出、Gemini `generateContent` の `inlineData` 送信構造を参考として流用する。ただし元実装の左右反転（`scaleX(-1)`）は文字認識の妨げになるため除去し、API呼び出しはフロントエンドから直接行わずバックエンド経由に分離する。
- `github.com/k-arindam/SwiftUICamera`（MIT License）および `github.com/Day1Labs/YOYO-Camera`（MIT License）はネイティブSwift実装であるため、ReactとTypeScriptによるPWA構成には移植しない。

## アプリの構成

フロントエンドはReact、TypeScript、Viteを用いたiPhone向けPWAとして構成する。ローカル開発時はNode.jsサーバー（`server/index.mjs`）を使用し、外部利用時はCloudflare Workers Free（`worker/index.mjs`）に静的アセットとAPI中継を配置する。使用するGemini APIのモデルは `gemini-3.8-flash`（`GEMINI_THINKING_LEVEL=high`）とし、APIキーはローカルの `.env` またはCloudflare Secretsで管理する。Google Cloudの有料サービスおよびAPI利用料金の計算・表示機能は実装しない。

## 無音カメラ仕様

背面カメラを `getUserMedia`（`audio: false`）で起動し、動画プレビューを表示する。撮影ボタンを押したときに `<canvas>` 要素へ現在の動画フレームを描画して静止画を取得する。iOSで別アプリへの切り替えや画面ロックから復帰した際にカメラが停止した場合は、ページ表示イベントおよびトラック終了イベントを検知して自動で復旧を試みる。アプリ自身はシャッター音を再生しないが、OSによる撮影音制約の回避は保証しない。文字認識に十分な解像度を維持しつつ、撮影した画像の永続保存（ストレージやサーバーへの書き出し）は行わない。

## 解答機能と画面構成

実装する画面はカメラ画面、解析中表示、解答・解説画面の3つとする。撮影した画像は自動的にバックエンド経由で送信し、1回の撮影につき原則1回のAPI呼び出しで設問と全選択肢を認識する。計算問題は可能な範囲で検算を行い、正答候補を大きく表示してその下に理由を簡潔に表示する。解答後はすぐに再撮影できるようにし、読めない画像は無理に解答せず撮り直しを促す。

## セキュリティと運用ルール

APIキーは `.env` またはCloudflare Secretsのみに記載し、Webクライアント、ソースコード、ログ、GitHubには含めない。`.env.example` と `.gitignore` を用意して誤コミットを防ぐ。Cloudflare Workers公開時はCloudflare Accessで利用者本人のメールアドレスのみを許可し、Worker側でも `ALLOWED_EMAIL` およびCloudflare AccessのJWT（RS256署名）を検証して無認証のAPI公開を防ぐ。Workers無料枠の範囲で運用し、設定が不完全な場合はアクセスを拒否する。

## 費用と開発に関する禁止事項

有料サービスの追加契約と有料プランへの変更は禁止する。Gemini APIのオートチャージ有効化、Google Cloudの新しい有料リソース作成、利用料金を計算または表示する機能の追加も行わない。今後の変更時にもAPIキー保護と本人認証の設定を損なわないよう保全する。
