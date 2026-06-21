#!/usr/bin/env node
/**
 * fetch-shorts.mjs
 * ------------------------------------------------------------
 * YouTube Data API v3 を使って「登録者数に対して再生数が
 * 異常に伸びているShorts」を集め、data/shorts.json を生成する。
 *
 * 使い方:
 *   YOUTUBE_API_KEY=xxxxx node fetch-shorts.mjs
 *
 * 必要な環境変数:
 *   YOUTUBE_API_KEY  ... YouTube Data API v3 のAPIキー（必須）
 *
 * 任意の環境変数:
 *   LOOKBACK_HOURS     ... 何時間以内に投稿された動画を対象にするか（デフォルト24）
 *   MAX_PER_GENRE      ... 各ジャンルから残す件数（デフォルト15）
 *   MIN_SUBSCRIBERS    ... 対象にするチャンネルの最低登録者数（デフォルト1000）
 *                          無名すぎるチャンネル（登録者数人〜数十人）をノイズとして除外する
 *   MIN_VIEW_COUNT     ... 対象にする動画の最低再生数（デフォルト1000）
 *                          再生数が極端に少ない動画は急上昇率が偶然高くなりやすいため除外する
 *
 * クォータの目安:
 *   search.list は1回100ユニット消費。ジャンル×検索語の数だけ
 *   呼び出すので、本設定（10ジャンル×1検索語）だと約1,000ユニット/回。
 *   1日10,000ユニットの無料枠内なら、1日数回の実行が可能。
 * ------------------------------------------------------------
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('エラー: 環境変数 YOUTUBE_API_KEY が設定されていません。');
  process.exit(1);
}

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const MAX_PER_GENRE = Number(process.env.MAX_PER_GENRE || 15);
const MIN_SUBSCRIBERS = Number(process.env.MIN_SUBSCRIBERS || 1000);
const MIN_VIEW_COUNT = Number(process.env.MIN_VIEW_COUNT || 1000);
const REGION_CODE = 'JP';
const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'shorts.json');

// ジャンルごとの検索キーワード。
// 日本語の "#shorts" 系キーワードでJPリージョンの動画を絞り込む。
const GENRES = [
  { id: 'game',    query: 'ゲーム実況 #shorts' },
  { id: 'cooking', query: '簡単レシピ #shorts' },
  { id: 'pets',    query: '犬 猫 #shorts' },
  { id: 'comedy',  query: 'あるある #shorts' },
  { id: 'beauty',  query: 'メイク #shorts' },
  { id: 'music',   query: '弾いてみた #shorts' },
  { id: 'sports',  query: 'スポーツ #shorts' },
  { id: 'talk',    query: '雑談 #shorts' },
];

const SEARCH_RESULTS_PER_GENRE = 25;

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------

async function callApi(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error (${endpoint}): ${res.status} ${body}`);
  }
  return res.json();
}

// "PT45S" / "PT1M5S" のようなISO8601の時間表現を秒数に変換する
function parseISODuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------

async function main() {
  const publishedAfter = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  console.log(`対象期間: ${publishedAfter} 以降に投稿された動画`);

  // 1) ジャンルごとに search.list でShorts候補を取得
  // videoId -> genre のマップ（同じ動画が複数ジャンルにマッチしたら最初のジャンルを優先）
  const videoGenreMap = new Map();

  for (const genre of GENRES) {
    try {
      const data = await callApi('search', {
        part: 'snippet',
        type: 'video',
        q: genre.query,
        order: 'viewCount',
        videoDuration: 'short', // 4分未満（後でShorts判定をさらに絞る）
        publishedAfter,
        regionCode: REGION_CODE,
        relevanceLanguage: 'ja',
        maxResults: SEARCH_RESULTS_PER_GENRE,
        safeSearch: 'moderate',
      });
      for (const item of data.items || []) {
        const id = item.id?.videoId;
        if (id && !videoGenreMap.has(id)) {
          videoGenreMap.set(id, genre.id);
        }
      }
      console.log(`[${genre.id}] ${data.items?.length || 0} 件取得`);
    } catch (err) {
      console.error(`[${genre.id}] 検索に失敗: ${err.message}`);
    }
  }

  const videoIds = [...videoGenreMap.keys()];
  if (videoIds.length === 0) {
    console.warn('動画が1件も取得できませんでした。');
    await writeOutput([]);
    return;
  }

  // 2) videos.list で詳細情報（統計・動画の長さ）を取得
  const videoDetails = [];
  for (const idsChunk of chunk(videoIds, 50)) {
    const data = await callApi('videos', {
      part: 'snippet,statistics,contentDetails',
      id: idsChunk.join(','),
    });
    videoDetails.push(...(data.items || []));
  }

  // 3) 60秒以下の動画だけをShortsとして残す
  const shorts = videoDetails.filter(v => {
    const seconds = parseISODuration(v.contentDetails?.duration || 'PT0S');
    return seconds > 0 && seconds <= 60;
  });
  console.log(`Shorts判定（60秒以下）: ${shorts.length} / ${videoDetails.length} 件`);

  // 4) チャンネルの登録者数を取得
  const channelIds = [...new Set(shorts.map(v => v.snippet.channelId))];
  const subscriberMap = new Map();
  for (const idsChunk of chunk(channelIds, 50)) {
    const data = await callApi('channels', {
      part: 'statistics',
      id: idsChunk.join(','),
    });
    for (const item of data.items || []) {
      const subs = item.statistics?.subscriberCount;
      // 登録者数を非公開にしているチャンネルは hiddenSubscriberCount が true
      subscriberMap.set(item.id, subs ? Number(subs) : null);
    }
  }

  // 5) 急上昇率（再生数 ÷ 登録者数）を計算して整形
  const videos = shorts
    .map(v => {
      const viewCount = Number(v.statistics?.viewCount || 0);
      const subscriberCount = subscriberMap.get(v.snippet.channelId);

      // 登録者数が非公開・取得不可の動画は急上昇率を計算できないため除外
      if (subscriberCount === null || subscriberCount === undefined) return null;

      // 登録者数・再生数が一定の規模に満たないチャンネル/動画は
      // 「たまたま」の確率が高くノイズになりやすいため除外する
      if (subscriberCount < MIN_SUBSCRIBERS) return null;
      if (viewCount < MIN_VIEW_COUNT) return null;

      const growthRatio = Math.round(viewCount / Math.max(subscriberCount, 1));

      return {
        id: v.id,
        title: v.snippet.title,
        channelTitle: v.snippet.channelTitle,
        channelId: v.snippet.channelId,
        genre: videoGenreMap.get(v.id) || 'other',
        publishedAt: v.snippet.publishedAt,
        viewCount,
        subscriberCount,
        growthRatio,
        thumbnail: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
      };
    })
    .filter(Boolean);

  console.log(`登録者数${MIN_SUBSCRIBERS}人以上・再生数${MIN_VIEW_COUNT}回以上でフィルタ後: ${videos.length} 件`);

  // 6) ジャンルごとに急上昇率が高い順に並べ、上位だけ残す
  const byGenre = new Map();
  for (const v of videos) {
    if (!byGenre.has(v.genre)) byGenre.set(v.genre, []);
    byGenre.get(v.genre).push(v);
  }
  let trimmed = [];
  for (const list of byGenre.values()) {
    list.sort((a, b) => b.growthRatio - a.growthRatio);
    trimmed.push(...list.slice(0, MAX_PER_GENRE));
  }
  trimmed.sort((a, b) => b.growthRatio - a.growthRatio);

  console.log(`最終的に ${trimmed.length} 件を出力します。`);
  await writeOutput(trimmed);
}

async function writeOutput(videos) {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    videos,
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(json, null, 2), 'utf-8');
  console.log(`書き込み完了: ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
