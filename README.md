# tomato-farm-manager

トマト栽培管理アプリ（MVP）。作業記録・農薬散布記録を、Android（Chromeでホーム画面に追加できるPWA）とブラウザの両方から記録・共有できる。

## 現在の機能（MVP）

- 作業記録（拠点・棟・作業分類・数量・所要時間などを記録）
- 農薬散布記録（農薬取締法に基づく省令第9条の法定5項目に対応。取消は理由必須の論理削除で行は残す）
- 履歴一覧（作業／農薬をタブ切替、期間・拠点で絞り込み）
- Android PWA化（ホーム画面に追加してオフラインでも起動可能）
- オフライン時の送信キュー（電波が弱いハウス内で記録→オンライン復帰時に自動送信）

## 構成

- `frontend/`：Vanilla HTML/CSS/JS（ビルドなし）。GitHub Pagesで公開する
- `gas/Code.gs`：Google Apps Script製バックエンド。Googleスプレッドシートをデータベースとして使う
- `docs/セットアップ手順.md`：導入手順

## セットアップ

`docs/セットアップ手順.md` を参照。

## 技術方針

`C:\Users\facta\projects\farm-work-log`（研修先向けの作業記録・指示システム）の実装パターンを踏襲している。GAS+スプレッドシートは無料で開発が速く、データをスプレッドシートで直接確認・編集できる点を重視して採用した。PWA化は `C:\Users\facta\dev\routine-board` のmanifest/service workerパターンを踏襲している。

## 次フェーズ（未実装）

- 天気予報取得→作業レコメンド
- 作業時間の自動計算（株数・収量などの変数×原単位）
- 人員配置（稼働人員に応じたシフト案の生成）

詳細は計画ファイル参照（`C:\Users\facta\.claude\plans\chrome-ticklish-lampson.md`）。
