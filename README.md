# snsclub-canva-calendar-aws

Google カレンダー → Canva の月間カレンダーテンプレへ自動転記するツール。
**Web UI（プレビューを見ながら操作）** と **月次バッチ（毎月25日 9:00 に翌月分を自動書き込み）** の2つがあり、
どちらも **AWS Fargate** で動く。田畑のMacは不要。

```
スタッフのブラウザ ──HTTPS──► ALB ──► Fargate Service  webServer.js (Xvfb + Chromium)
                                              │  スクショを返す / クリック・入力を転送
                                              ▼
                                           Canva（ログイン状態は S3 から復元）
EventBridge Scheduler（毎月25日 9:00 JST）──► Fargate RunTask  runScheduled.js --auto
GitHub Actions（main に push）──► Docker build ──► ECR ──► ECS サービス更新
```

## 仕組みの要点
- **ブラウザは AWS 上で headless:false のまま動く**（Xvfb の仮想画面）。Canva は headless だと Bot 判定されやすいため、Mac で実績のある動かし方を保つ。
- **Canva のログイン状態は S3**（`session/canva-storageState.json`）に保存し、Web UI と月次バッチで共有する。コンテナが入れ替わっても消えない。
- **ログインだけは人が行う**。AWS 上のブラウザには画面が無いので、Web UI の「🔑 Canvaログイン」でスクショをクリック・文字入力してログインし、「ログイン状態を保存」を押す（メール認証コードもこの画面で入力できる）。手元PCでログインして保存する `npm run session:login` もある。
- 月次バッチは S3 のログイン状態が無い／切れていると **明確なエラーで止まる**（誤ったページに書かない）。Discord Webhook を設定すれば成否が通知される。
- Web UI は同時に1タスクだけ動く（ブラウザセッションは1つ）。使わない期間は `DesiredCount=0` にして停止できる。月次バッチはサービスの稼働数に関係なく独立して動く。

## ファイル構成
```
src/webServer.js      Web UI（起動/ページ確認/書き込み + 🔑ログイン用リモート操作）
src/runScheduled.js   月次バッチ（--auto で無人実行）
src/cloudSession.js   S3 とのログイン状態の保存/復元、リモート操作の座標変換
src/canvaCore.js ほか Canva 操作の中核（Mac 時代から共通）
scripts/canva-session-login.js   手元PCで Canva にログインして S3 に保存
scripts/docker-entrypoint.sh     Xvfb 上でコマンドを起動
Dockerfile / .dockerignore
aws/template.yaml     CloudFormation（VPC, ALB, ECS, ECR, S3, Scheduler, IAM）
.github/workflows/deploy.yml     main へ push → ECR → ECS
```

## デプロイ（担当者）

### 0. 前提
- AWS CLI（認証済み）／GitHub リポジトリの Secrets を設定できる権限
- HTTPS にする場合: ACM で証明書を発行（例 `canva.levela.co.jp`）。DNS はデプロイ後に ALB へ向ける

### 1. CloudFormation スタックを作る（初回は DesiredCount=0）
```bash
aws cloudformation deploy \
  --stack-name snsclub-canva-calendar \
  --template-file aws/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WebPassword='スタッフに配るパスワード' \
    CertificateArn='arn:aws:acm:...'            # HTTPS にしない検証時は省略可 \
    DiscordNotifyWebhookUrl='https://discord.com/api/webhooks/...'   # 任意
```
出力（`aws cloudformation describe-stacks --stack-name snsclub-canva-calendar --query 'Stacks[0].Outputs'`）:
- `EcrRepositoryUri` … GitHub Actions の push 先
- `SessionBucketName` … ログイン状態の保存先
- `LoadBalancerDnsName` … 独自ドメインの CNAME 先 / `WebUrl`

### 2. GitHub Secrets を設定して push
リポジトリの Settings → Secrets and variables → Actions:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（ECR push と `ecs:UpdateService` ができる IAM ユーザー）
- `AWS_REGION`（例 `ap-northeast-1`）

`main` に push すると `.github/workflows/deploy.yml` が テスト → build → ECR push → サービス更新 を行う。
手動で走らせる場合は Actions タブの「deploy」→ Run workflow。

### 3. サービスを起動
イメージが ECR に入ったら Web UI を 1 タスク起動する:
```bash
aws cloudformation deploy --stack-name snsclub-canva-calendar --template-file aws/template.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides DesiredCount=1 WebPassword='...' CertificateArn='...'
# または
aws ecs update-service --cluster snsclub-canva-calendar --service snsclub-canva-calendar-web --desired-count 1
```
2〜3分で `WebUrl` にアクセスできる（HTTPS の場合は DNS を `LoadBalancerDnsName` に向けてから）。

### 4. Canva にログインして保存（初回・ログイン切れ時）
Web UI を開き → 「🔑 Canvaログイン」→「ログイン画面を開く」→ スクショをクリック／文字を入力してログイン
→ ホーム画面になったら「💾 ログイン状態を保存」。これで月次バッチも同じログインで動く。

手元PCで行う場合:
```bash
npm install && npx playwright install chromium
npm run session:login -- --bucket <SessionBucketName>
```

### 5. 月次バッチの動作確認（本番 Canva に書き込むので、使っていないページで）
```bash
aws ecs run-task --cluster snsclub-canva-calendar --launch-type FARGATE \
  --task-definition <TaskDefinitionArn> \
  --network-configuration "awsvpcConfiguration={subnets=[<SubnetIds>],securityGroups=[<TaskSecurityGroupId>],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","src/runScheduled.js","--auto","--target=2026-11","--page=40"]}]}'
```
ログは CloudWatch Logs `/ecs/snsclub-canva-calendar`。`--page` は使っていないページ番号を指定する。

## 運用
| やりたいこと | 方法 |
|---|---|
| Web UI を止めて節約 | `aws ecs update-service ... --desired-count 0`（月次バッチは影響なし） |
| 月次バッチを止める | スタックの `ScheduleEnabled=DISABLED` |
| 実行時刻を変える | `ScheduleExpression`（例 `cron(0 9 25 * ? *)`、タイムゾーンは Asia/Tokyo） |
| テンプレの Canva を変えた | `CanvaDesignUrl` パラメータ（`config.js` を変えなくてよい） |
| パスワード変更 | `WebPassword` で再デプロイ |
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
