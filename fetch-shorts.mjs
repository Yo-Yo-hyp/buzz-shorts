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
 *   search.list は1回100ユニット消費。ジャンル×地域(言語)の組み合わせの数だけ
 *   呼び出す。本設定（11ジャンル・計18クエリ＝JP圏11 + 海外(英語)圏7）だと
 *   約1,800ユニット/回。1日4回実行（6時間おき）でも1日7,200ユニット程度で、
 *   無料枠(1日10,000ユニット)に収まる。
 * ------------------------------------------------------------
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('エラー: 環境変数 YOUTUBE_API_KEY が設定されていません。');
  process.exit(1);
}

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const MAX_PER_GENRE = Number(process.env.MAX_PER_GENRE || 20);
const MIN_SUBSCRIBERS = Number(process.env.MIN_SUBSCRIBERS || 1000);
const MIN_VIEW_COUNT = Number(process.env.MIN_VIEW_COUNT || 1000);
const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'shorts.json');

// ジャンルごとに「地域(言語)バリアント」を複数持てるようにした。
// 日本語圏(JP)と英語圏(US)、両方で検索することで海外の動画も拾えるようにする。
// requireJapanese: true の場合、タイトルに日本語が含まれない動画は除外する
//   （日本語検索なのに海外勢の無関係な動画が紛れ込むのを防ぐため）。
// matchKeywords のうち1つでもタイトル/説明文に含まれていればそのジャンルと判定する
//（検索結果には関連度の低い動画も混じるため、ここで二重チェックする）。
const GENRES = [
  {
    id: 'game',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: 'ゲーム実況 #shorts',
        matchKeywords: ['ゲーム', 'プレイ', '実況', 'クリア', 'ボス', 'RTA', 'eスポーツ'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'gaming shorts',
        matchKeywords: ['game', 'gaming', 'gameplay', 'boss', 'glitch', 'speedrun', 'clutch', 'win', 'fail'] },
    ],
  },
  {
    id: 'cooking',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: '簡単レシピ #shorts',
        matchKeywords: ['レシピ', '料理', '作り方', 'クッキング', 'ごはん', '飯', '食材', 'おかず'] },
    ],
  },
  {
    id: 'pets',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: '犬 猫 動物 #shorts',
        matchKeywords: ['犬', '猫', 'ねこ', 'いぬ', 'ペット', '動物', 'わんこ', 'にゃんこ', '鳥', 'うさぎ'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'animals pets shorts',
        matchKeywords: ['dog', 'cat', 'pet', 'animal', 'puppy', 'kitten', 'wildlife', 'cute'] },
    ],
  },
  {
    id: 'comedy',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: 'あるある #shorts',
        matchKeywords: ['あるある', '笑', 'コント', 'ネタ', 'ボケ', 'ツッコミ', 'お笑い'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'funny comedy shorts',
        matchKeywords: ['funny', 'comedy', 'prank', 'joke', 'fail', 'skit', 'hilarious'] },
    ],
  },
  {
    id: 'beauty',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: 'メイク 美容 #shorts',
        matchKeywords: ['メイク', '美容', 'コスメ', 'スキンケア', 'ヘアアレンジ', '化粧'] },
    ],
  },
  {
    id: 'music',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: '弾いてみた 歌ってみた #shorts',
        matchKeywords: ['弾いてみた', '歌ってみた', 'カバー', 'ギター', 'ピアノ', '演奏', '作曲', 'Cover'] },
    ],
  },
  {
    id: 'sports',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: 'スポーツ 筋トレ #shorts',
        matchKeywords: ['サッカー', '野球', 'バスケ', 'スポーツ', '筋トレ', 'トレーニング', 'リフティング'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'sports highlights shorts',
        matchKeywords: ['sports', 'soccer', 'football', 'basketball', 'workout', 'gym', 'training', 'highlight'] },
    ],
  },
  {
    id: 'talk',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: '雑談 あるある話 #shorts',
        matchKeywords: ['雑談', '話', 'トーク', '相談', 'エピソード'] },
    ],
  },
  {
    id: 'trivia',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: '雑学 豆知識 #shorts',
        matchKeywords: ['雑学', '豆知識', 'トリビア', '知識', 'なぜ', '意外'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'facts trivia shorts',
        matchKeywords: ['fact', 'facts', 'trivia', 'did you know', 'random fact', 'science'] },
    ],
  },
  {
    id: 'asmr',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: false, query: 'ASMR #shorts',
        matchKeywords: ['ASMR', '咀嚼音', '耳かき', '癒し', '睡眠'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'ASMR satisfying shorts',
        matchKeywords: ['asmr', 'satisfying', 'relax', 'tingles', 'sound'] },
    ],
  },
  {
    id: 'diy',
    variants: [
      { region: 'JP', lang: 'ja', requireJapanese: true, query: 'ライフハック 便利グッズ #shorts',
        matchKeywords: ['ライフハック', '便利グッズ', '裏技', 'DIY', '収納', '時短'] },
      { region: 'US', lang: 'en', requireJapanese: false, query: 'DIY life hack shorts',
        matchKeywords: ['diy', 'life hack', 'hack', 'trick', 'tips', 'build'] },
    ],
  },
];

const SEARCH_RESULTS_PER_GENRE = 30;

// ---------------------------------------------------------------
// 予想ゲーム関連設定
// ---------------------------------------------------------------
// 動画が最初に観測されてから何時間後に「答え合わせ」するか
const PREDICT_CHECK_HOURS = 6;
// 答え合わせが済んでいない動画を、検索結果に出てこなくなっても
// 何時間まで再取得して粘るか（この間に答え合わせが確定する）
const PREDICT_PENDING_MAX_HOURS = 18;

// 6時間後の伸び倍率(現在の再生数 ÷ 観測開始時点の再生数)から3段階を判定する
function resolveTier(ratio) {
  if (ratio >= 3) return 'blast';   // 爆伸び
  if (ratio >= 1.2) return 'normal'; // 普通
  return 'slow';                     // 伸び悩み
}

// 直前の実行結果(data/shorts.json)を読み込む。存在しない/壊れている場合は空扱い。
async function readPreviousOutput() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf-8');
    const json = JSON.parse(raw);
    const map = new Map();
    for (const v of json.videos || []) map.set(v.id, v);
    return map;
  } catch {
    return new Map();
  }
}

// 日本語（ひらがな・カタカナ・漢字）の文字が含まれているかを判定する。
// 海外勢の動画やローマ字のみのタイトルを弾くための簡易フィルタ。
function containsJapanese(text){
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text || '');
}

// タイトル・説明文にキーワードが実際に含まれているか確認する（大文字小文字を無視）。
// 検索結果には関連度の低い動画も混じるため、ここで二重チェックする。
function matchesKeywords(keywords, title, description){
  const text = `${title} ${description}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

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

  // 1) ジャンル×地域バリアントごとに search.list でShorts候補を取得
  // videoId -> genre のマップ（同じ動画がJP/US両方の検索にヒットしても最初の1回だけ採用）
  const videoGenreMap = new Map();

  for (const genre of GENRES) {
    for (const variant of genre.variants) {
      try {
        const data = await callApi('search', {
          part: 'snippet',
          type: 'video',
          q: variant.query,
          order: 'viewCount',
          videoDuration: 'short', // 4分未満（後でShorts判定をさらに絞る）
          publishedAfter,
          regionCode: variant.region,
          relevanceLanguage: variant.lang,
          maxResults: SEARCH_RESULTS_PER_GENRE,
          safeSearch: 'moderate',
        });

        let matched = 0;
        for (const item of data.items || []) {
          const id = item.id?.videoId;
          const title = item.snippet?.title || '';
          const description = item.snippet?.description || '';
          if (!id || videoGenreMap.has(id)) continue;

          // JP圏の検索なのに日本語タイトルでない動画（無関係な海外勢など）はここで除外
          if (variant.requireJapanese && !containsJapanese(title)) continue;

          // タイトル/説明文にジャンルキーワードが含まれているかチェック
          if (!matchesKeywords(variant.matchKeywords, title, description)) continue;

          videoGenreMap.set(id, genre.id);
          matched++;
        }
        console.log(`[${genre.id}/${variant.region}] ${data.items?.length || 0} 件取得 → ジャンル一致 ${matched} 件`);
      } catch (err) {
        console.error(`[${genre.id}/${variant.region}] 検索に失敗: ${err.message}`);
      }
    }
  }

  // 1.5) 前回まで答え合わせが済んでいなかった動画を、検索結果から漏れていても
  //      再取得の対象に加える（そうしないと答え合わせのタイミングを逃してしまう）
  const prevMap = await readPreviousOutput();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  let pendingCarried = 0;
  for (const [id, prev] of prevMap) {
    if (videoGenreMap.has(id)) continue; // 今回の検索でも見つかった動画はそのまま
    if (prev.resolvedAt) continue; // 答え合わせ済みならもう追いかけなくてよい
    const firstSeenMs = new Date(prev.firstSeenAt || prev.publishedAt).getTime();
    const ageHours = (now - firstSeenMs) / 3600000;
    if (ageHours > PREDICT_PENDING_MAX_HOURS) continue; // 粘りすぎない
    videoGenreMap.set(id, prev.genre);
    pendingCarried++;
  }
  if (pendingCarried > 0) {
    console.log(`答え合わせ待ちのため ${pendingCarried} 件を追加で再取得します。`);
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

      // ---- 予想ゲーム用フィールド ----
      // firstSeenAt/firstSeenViewCount: この動画を最初に観測した時点の再生数（予想の基準点）
      // resolvedTier/resolvedAt: 観測開始からPREDICT_CHECK_HOURS経過後に確定する答え
      const prev = prevMap.get(v.id);
      const firstSeenAt = prev?.firstSeenAt || nowISO;
      const firstSeenViewCount = prev?.firstSeenViewCount ?? viewCount;
      let resolvedTier = prev?.resolvedTier ?? null;
      let resolvedAt = prev?.resolvedAt ?? null;
      let sixHourGrowthRatio = prev?.sixHourGrowthRatio ?? null;

      if (!resolvedAt) {
        const ageHours = (now - new Date(firstSeenAt).getTime()) / 3600000;
        if (ageHours >= PREDICT_CHECK_HOURS) {
          const ratio = viewCount / Math.max(firstSeenViewCount, 1);
          resolvedTier = resolveTier(ratio);
          resolvedAt = nowISO;
          sixHourGrowthRatio = Number(ratio.toFixed(2));
        }
      }

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
        firstSeenAt,
        firstSeenViewCount,
        predictCheckHours: PREDICT_CHECK_HOURS,
        resolvedTier,
        resolvedAt,
        sixHourGrowthRatio,
      };
    })
    .filter(Boolean);

  console.log(`登録者数${MIN_SUBSCRIBERS}人以上・再生数${MIN_VIEW_COUNT}回以上でフィルタ後: ${videos.length} 件`);

  // 6) ジャンルごとに急上昇率が高い順に並べ、上位だけ残す
  //    （表示用の間引き。答え合わせ待ちの動画は間引かれても answerPending として残す）
  const byGenre = new Map();
  for (const v of videos) {
    if (!byGenre.has(v.genre)) byGenre.set(v.genre, []);
    byGenre.get(v.genre).push(v);
  }
  let trimmed = [];
  const trimmedIds = new Set();
  for (const list of byGenre.values()) {
    list.sort((a, b) => b.growthRatio - a.growthRatio);
    const kept = list.slice(0, MAX_PER_GENRE);
    kept.forEach(v => trimmedIds.add(v.id));
    trimmed.push(...kept);
  }

  // 表示枠から漏れたが、まだ答え合わせが済んでいない動画はフィードには出さず
  // 予想の答え合わせ専用データとして残す（predictionOnly: true）
  const pendingOnly = videos
    .filter(v => !trimmedIds.has(v.id) && !v.resolvedAt)
    .map(v => ({ ...v, predictionOnly: true }));

  const output = [...trimmed, ...pendingOnly];
  output.sort((a, b) => b.growthRatio - a.growthRatio);

  console.log(`最終的に ${trimmed.length} 件をフィードに、${pendingOnly.length} 件を答え合わせ待ちとして出力します。`);
  await writeOutput(output);
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
