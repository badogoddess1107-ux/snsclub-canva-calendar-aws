# snsclub-canva-calendar-aws

Google カレンダー → Canva の月間カレンダーテンプレへ自動転記するツール。
**Web UI（プレビューを見ながら操作）** と **月次バッチ（毎月25日 9:00 に翌月分を自動書き込み）** があり、
どちらも **AWS Fargate で「使う時だけ」動く**。田畑のMacは不要で、**固定費が発生するリソースは無い**。

```
スタッフ ──► 起動ページ（Lambda, 無料枠）──► Fargate タスク [Web UI + ngrok]
                                                  │  ngrok の固定URLで公開（無料）
                                                  │  無操作60分で自分で停止 ＝ 課金停止
                                                  ▼
                                                Canva（ログイン状態は S3 から復元）
EventBridge Scheduler（毎月25日 9:00 JST）──► Fargate タスク [月次バッチ]（数十分で終了）
GitHub Actions（main に push）──► Docker build ──► ECR
```

## 費用（東京リージョン・概算）
| 項目 | 月額 |
|---|---|
| Web UI（Fargate 2vCPU/4GB、使った時間分のみ） | 1時間あたり約15円。月に数時間なら **100円未満** |
| 月次バッチ（月1回・1時間以内） | **約15円** |
| 起動ページ（Lambda Function URL）／S3／ECR／CloudWatch Logs | 無料枠内〜**数十円** |
| ngrok | **無料**（無料プランの固定ドメイン） |
| **合計** | **月100〜200円程度**。Web UI を使わない月はさらに少ない |

固定費（ロードバランサー・NAT・常時稼働）は一切使っていない。

## 仕組みの要点
- **Web UI は「起動ページ」で立ち上げる**。スタッフが起動ページ（URLとパスワードを配布）で「起動」を押すと Fargate タスクが起動し、2〜3分後に ngrok の固定URL で Web UI が開く。
- **無操作が続くと Web UI は自分で終了する**（既定60分。書き込み中は止めない）。終了＝課金停止。また起動ページから起動すればよい。
- **ブラウザは AWS 上で headless:false のまま動く**（Xvfb の仮想画面）。Canva は headless だと Bot 判定されやすいため、Mac で実績のある動かし方を保つ。
- **Canva のログイン状態は S3**（`session/canva-storageState.json`）に保存し、Web UI と月次バッチで共有する。タスクが入れ替わっても消えない。
- **ログインだけは人が行う**。Web UI の「🔑 Canvaログイン」でスクショをクリック・文字入力してログインし、「ログイン状態を保存」を押す（メール認証コードもこの画面で入力できる）。手元PCでログインして保存する `npm run session:login` もある。
- 月次バッチは S3 のログイン状態が無い／切れていると **明確なエラーで止まる**（誤ったページに書かない）。Discord Webhook を設定すれば成否が通知される。
- ngrok 無料プランは 1 アカウント 1 接続。Mac 側の ngrok（`com.user.ngrok-canva`）と同じアカウントを使うなら、AWS 稼働確認後に Mac 側を止める。

## ファイル構成
```
src/webServer.js      Web UI（起動/ページ確認/書き込み + 🔑ログイン用リモート操作 + 無操作自動停止）
src/runScheduled.js   月次バッチ（--auto で無人実行）
src/cloudSession.js   S3 とのログイン状態の保存/復元、リモート操作の座標変換、自動停止判定
src/canvaCore.js ほか Canva 操作の中核（Mac 時代から共通）
scripts/canva-session-login.js   手元PCで Canva にログインして S3 に保存
scripts/docker-entrypoint.sh     Xvfb 上でコマンドを起動
Dockerfile / .dockerignore
aws/template.yaml     CloudFormation（VPC, ECS, ECR, S3, Scheduler, 起動ページ Lambda, IAM）
.github/workflows/deploy.yml     main へ push → ECR
```

## デプロイ（担当者）

### 0. 用意するもの
- AWS CLI（認証済み）／GitHub リポジトリの Secrets を設定できる権限
- ngrok の **Authtoken** と **固定ドメイン**（ダッシュボード → Your Authtoken / Domains）。
  Mac で使っていた canva 用アカウント（`syrup-figment-submitter.ngrok-free.dev`）をそのまま使える

### 1. CloudFormation スタックを作る
```bash
aws cloudformation deploy \
  --stack-name snsclub-canva-calendar \
  --template-file aws/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WebPassword='Web UI のパスワード' \
    StartPageKey='起動ページのパスワード' \
    NgrokAuthtoken='ngrok の Authtoken' \
    NgrokDomain='syrup-figment-submitter.ngrok-free.dev' \
    DiscordNotifyWebhookUrl='https://discord.com/api/webhooks/...'   # 任意
```
出力（`aws cloudformation describe-stacks --stack-name snsclub-canva-calendar --query 'Stacks[0].Outputs'`）:
- `StartPageUrl` … スタッフに配る「起動ページ」の URL
- `WebUrl` … 起動後に開く Web UI の URL（ngrok 固定ドメイン）
- `SessionBucketName` … ログイン状態の保存先
- `EcrRepositoryUri` … GitHub Actions の push 先

### 2. GitHub Secrets を設定して push
リポジトリの Settings → Secrets and variables → Actions:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（ECR に push できる IAM ユーザー）
- `AWS_REGION`（例 `ap-northeast-1`）

`main` に push すると `.github/workflows/deploy.yml` が テスト → build → ECR push を行う。
手動で走らせる場合は Actions タブの「deploy」→ Run workflow。

### 3. 起動して Canva にログイン（初回・ログイン切れ時）
1. `StartPageUrl` を開き、`StartPageKey` を入れて「🚀 起動する」
2. 2〜3分後に `WebUrl` を開く（初回は ngrok の警告ページで「Visit Site」）→ `WebPassword` でログイン
3. 「🔑 Canvaログイン」→「ログイン画面を開く」→ スクショをクリック／文字を入力して Canva にログイン
4. ホーム画面になったら「💾 ログイン状態を保存」。これで月次バッチも同じログインで動く

手元PCで行う場合:
```bash
npm install && npx playwright install chromium
npm run session:login -- --bucket <SessionBucketName>
```

### 4. 月次バッチの動作確認（本番 Canva に書き込むので、使っていないページで）
```bash
aws ecs run-task --cluster snsclub-canva-calendar --launch-type FARGATE \
  --task-definition <BatchTaskDefinitionArn> \
  --network-configuration "awsvpcConfiguration={subnets=[<SubnetIds>],securityGroups=[<TaskSecurityGroupId>],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/runScheduled.js","--auto","--target=2026-11","--page=40"]}]}'
```
ログは CloudWatch Logs `/ecs/snsclub-canva-calendar`。`--page` は使っていないページ番号を指定する。

### 5. Mac 側の停止（AWS で問題なく動いたら）
```bash
launchctl bootout gui/$(id -u)/com.user.ngrok-canva          # ngrok（同じアカウントなら必須。1接続制限）
launchctl bootout gui/$(id -u)/com.tabata.canva-webserver    # Web UI
launchctl bootout gui/$(id -u)/com.user.canva-calendar-sync  # 月次バッチ（二重書き込み防止）
```

## スタッフへの案内文（例）
```
【Canvaカレンダー書き込みツール（AWS版）】
1. 起動ページ: <StartPageUrl>  パスワード: <StartPageKey>
   「起動する」を押して 2〜3分待つ
2. ツール: https://syrup-figment-submitter.ngrok-free.dev/  パスワード: <WebPassword>
   初回は「Visit Site」を押す
※ 60分 操作が無いと自動で止まります。止まっていたら 1 からやり直してください。
```

## 運用
| やりたいこと | 方法 |
|---|---|
| 今すぐ Web UI を止める | Web UI で「閉じる」→ 放置（60分後に自動停止）。即時なら `aws ecs stop-task` |
| 自動停止までの時間を変える | `IdleExitMinutes` で再デプロイ |
| 月次バッチを止める | `ScheduleEnabled=DISABLED` |
| 実行時刻を変える | `ScheduleExpression`（例 `cron(0 9 25 * ? *)`、タイムゾーンは Asia/Tokyo） |
| テンプレの Canva を変えた | `CanvaDesignUrl` パラメータ |
| パスワード変更 | `WebPassword` / `StartPageKey` で再デプロイ |
| ログイン切れ | Web UI の「🔑 Canvaログイン」で再ログイン→保存 |

## ローカル（Mac）で動かす場合
従来通り。`CANVA_SESSION_BUCKET` を設定しなければ AWS 機能は無効で、`.browser-profile` を使う。
```bash
npm install && npx playwright install chromium
CANVA_WEB_PASSWORD=xxxx npm run web
```

## 注意
- `Dockerfile` の Playwright イメージのタグ（`v1.59.1-jammy`）と `package.json` の `playwright` のバージョンは揃える。
- Canva 側の UI 変更で操作が失敗することがある。Web UI の進捗ログとスクショで状況を確認する。
- AWS の IP からのログインを Canva が不審と判断し、メール認証を求めることがある。その場合も「🔑 Canvaログイン」画面でコードを入力できる。
- ngrok 無料プランはアカウントごとに同時1接続。Mac 側の ngrok を止めずに AWS を起動すると片方が繋がらない。
