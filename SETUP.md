# セットアップ手順（初めての方向け）

このアプリを実際に使えるようにするには、あと2つだけ準備が必要です。
「Supabase（データの保存先）」と「GitHub Pages（アプリの公開場所）」です。
どちらも無料で作れます。

## 1. Supabaseプロジェクトを作る

1. https://supabase.com にアクセスし、GitHubアカウントなどでサインアップ
2. 「New project」から新規プロジェクトを作成（名前は任意、リージョンは Tokyo (ap-northeast-1) がおすすめ）
3. 作成が終わったら、左メニューの **SQL Editor** を開き、このフォルダの `supabase.sql` の中身を貼り付けて実行（テーブルとアクセス制御ができます）
4. 左メニューの **Project Settings > API** を開き、次の2つをメモ
   - Project URL（例: `https://xxxxx.supabase.co`）
   - anon public key（長い文字列）
5. `storage.js` の一番上にある `SUPABASE_URL` と `SUPABASE_ANON_KEY` を、メモした値に書き換える
6. 左メニューの **Authentication > URL Configuration** を開き、「Redirect URLs」に、後述のGitHub PagesのURL（例: `https://ユーザー名.github.io/リポジトリ名/`）を追加

## 2. GitHubで公開する

1. GitHubで新しいリポジトリを作成
2. この `task-calendar` フォルダの中身をそのリポジトリにpush
3. リポジトリの **Settings > Pages** で、公開元を「main ブランチ / ルート」に設定
4. 数分待つと `https://ユーザー名.github.io/リポジトリ名/` でアプリが開けるようになります
5. そのURLを、手順1-6の「Redirect URLs」に追加し忘れていないか確認

## 3. 各端末に追加する

- iPhone/iPad: SafariでURLを開き、共有ボタン →「ホーム画面に追加」
- MacBook: Safariでメニューの「ファイル」→「Dockに追加」（またはURLをブックマーク）

## 4. ログイン

1. 表示された画面でメールアドレス（masa.ikuei@gmail.com など）を入力し送信
2. 届いたメール内のリンクを開くとログイン完了
3. 同じメールアドレスで3台ともログインすれば、データが共有されます

## 5. 今使っているデータを引き継ぐ

1. 元のClaudeアーティファクト（task-calendar.html）を開き、「⋯」→「データを書き出す」でJSONファイルを保存
2. 新しいアプリにログイン後、同じく「⋯」→「データを読み込む」でそのJSONファイルを選択

## 困ったときは

- ログインメールが届かない: 迷惑メールフォルダを確認。Supabaseの無料枠はメール送信数に制限があるため、数分待って再送してください。
- 保存に失敗した旨のバナーが出る: 画面下の「再試行」を押すか、通信状況を確認してください。
