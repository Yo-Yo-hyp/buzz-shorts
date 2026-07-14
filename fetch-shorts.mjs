#!/usr/bin/env node
/**
 * fetch-shorts.mjs
 * ------------------------------------------------------------
 * YouTube Data API v3 — 日本（JP）特化の急上昇Shorts収集
 * data/shorts.json を生成（50〜100本規模）
 *
 * 使い方:
 *   YOUTUBE_API_KEY=xxxxx node fetch-shorts.mjs
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
const MAX_PER_GENRE = Number(process.env.MAX_PER_GENRE || 8);
const MIN_SUBSCRIBERS = Number(process.env.MIN_SUBSCRIBERS || 50);
const MIN_VIEW_COUNT = Number(process.env.MIN_VIEW_COUNT || 500);
const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'shorts.json');

// 日本（JP）特化 — 全ジャンル regionCode: JP / 日本語限定
const GENRES = [
  { id: 'game', query: 'ゲーム実況 #shorts',
    matchKeywords: ['ゲーム', 'プレイ', '実況', 'クリア', 'ボス', 'RTA', 'eスポーツ', 'minecraft', 'マイクラ'] },
  { id: 'cooking', query: '簡単レシピ #shorts',
    matchKeywords: ['レシピ', '料理', '作り方', 'クッキング', 'ごはん', '飯', '食材', 'おかず'] },
  { id: 'pets', query: '犬 猫 動物 #shorts',
    matchKeywords: ['犬', '猫', 'ねこ', 'いぬ', 'ペット', '動物', 'わんこ', 'にゃんこ', '鳥', 'うさぎ'] },
  { id: 'comedy', query: 'あるある #shorts',
    matchKeywords: ['あるある', '笑', 'コント', 'ネタ', 'ボケ', 'ツッコミ', 'お笑い'] },
  { id: 'beauty', query: 'メイク 美容 #shorts',
    matchKeywords: ['メイク', '美容', 'コスメ', 'スキンケア', 'ヘアアレンジ', '化粧'] },
  { id: 'music', query: '弾いてみた 歌ってみた #shorts',
    matchKeywords: ['弾いてみた', '歌ってみた', 'カバー', 'ギター', 'ピアノ', '演奏', '作曲', 'Cover'] },
  { id: 'sports', query: 'スポーツ 筋トレ #shorts',
    matchKeywords: ['サッカー', '野球', 'バスケ', 'スポーツ', '筋トレ', 'トレーニング', 'リフティング'] },
  { id: 'talk', query: '雑談 あるある話 #shorts',
    matchKeywords: ['雑談', '話', 'トーク', '相談', 'エピソード'] },
  { id: 'trivia', query: '雑学 豆知識 #shorts',
    matchKeywords: ['雑学', '豆知識', 'トリビア', '知識', 'なぜ', '意外'] },
  { id: 'asmr', query: 'ASMR #shorts',
    matchKeywords: ['ASMR', '咀嚼音', '耳かき', '癒し', '睡眠', 'satisfying'] },
  { id: 'diy', query: 'ライフハック 便利グッズ #shorts',
    matchKeywords: ['ライフハック', '便利グッズ', '裏技', 'DIY', '収納', '時短'] },
];

const SEARCH_RESULTS_PER_GENRE = Number(process.env.SEARCH_RESULTS_PER_GENRE || 100);
const PREDICT_CHECK_HOURS = Number(process.env.PREDICT_CHECK_HOURS || 6);
const PREDICT_PENDING_MAX_HOURS = 18;

const BUZZ_KEYWORD_PATTERNS = [
  'あるある', '雑学', '豆知識', '裏技', 'ライフハック', 'ASMR', '料理', 'レシピ',
  'ゲーム', '実況', '猫', '犬', 'ペット', 'メイク', '美容', '筋トレ', 'スポーツ',
  '歌ってみた', '弾いてみた', 'マイクラ', 'minecraft', 'トレンド', 'バズ', '神回',
];

const EDIT_TEMPLATE_RULES = [
  { tag: '高速カット系', patterns: ['#shorts', '切り抜き', 'ハイライト', 'まとめ', '秒'] },
  { tag: 'テキスト読み上げ系', patterns: ['雑学', '豆知識', 'ナレーション', '解説', 'トリビア'] },
  { tag: 'リアクション系', patterns: ['あるある', '反応', 'リアクション', 'びっくり', '驚'] },
  { tag: 'How-to系', patterns: ['作り方', 'やり方', '方法', 'レシピ', 'DIY', '裏技'] },
  { tag: 'BGMダンス系', patterns: ['ダンス', '踊', 'チャレンジ', 'トレンド', '音源'] },
];

const AUDIO_HINT_PATTERNS = [
  { name: 'オリジナル音源', patterns: ['オリジナル', '自作'] },
  { name: 'トレンド音源', patterns: ['トレンド', '流行', 'バズ'] },
  { name: 'ASMR音', patterns: ['ASMR', '咀嚼', '耳かき'] },
  { name: 'カバー曲', patterns: ['歌ってみた', 'カバー', '弾いてみた'] },
  { name: '効果音メイン', patterns: ['効果音', 'SE', 'ドン'] },
];

function resolveTier(ratio) {
  if (ratio >= 3) return 'blast';
  if (ratio >= 1.2) return 'normal';
  return 'slow';
}

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

function containsJapanese(text) {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text || '');
}

function matchesKeywords(keywords, title, description) {
  const text = `${title} ${description}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

function extractBuzzKeywords(title) {
  const found = new Set();
  const hashtags = (title.match(/#[\w\u3040-\u30FF\u4E00-\u9FFF]+/g) || []);
  hashtags.forEach(h => found.add(h));
  for (const kw of BUZZ_KEYWORD_PATTERNS) {
    if (title.includes(kw)) found.add(kw.startsWith('#') ? kw : `#${kw}`);
  }
  return [...found].slice(0, 6);
}

function guessEditTemplate(title) {
  const tags = [];
  for (const rule of EDIT_TEMPLATE_RULES) {
    if (rule.patterns.some(p => title.includes(p))) tags.push(rule.tag);
  }
  return tags.length ? tags : ['ショート汎用型'];
}

function guessAudioHint(title) {
  for (const rule of AUDIO_HINT_PATTERNS) {
    if (rule.patterns.some(p => title.includes(p))) return rule.name;
  }
  return '不明音源';
}

function estimateEngagementGrade(likeCount, commentCount, viewCount) {
  if (!viewCount) return 'B';
  const likeRate = likeCount / viewCount;
  const commentRate = commentCount / viewCount;
  const score = likeRate * 100 + commentRate * 500;
  if (score >= 8) return 'AA';
  if (score >= 4) return 'A';
  return 'B';
}

function estimateAvgViews(subscriberCount) {
  return Math.max(100, Math.round(subscriberCount * 0.08));
}

function isGenreMatch(title, genreId) {
  const genre = GENRES.find(g => g.id === genreId);
  if (!genre) return true;
  return matchesKeywords(genre.matchKeywords, title, '');
}

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

async function main() {
  const publishedAfter = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  console.log(`対象期間: ${publishedAfter} 以降（JP特化）`);

  const videoGenreMap = new Map();

  for (const genre of GENRES) {
    try {
      const data = await callApi('search', {
        part: 'snippet',
        type: 'video',
        q: genre.query,
        order: 'viewCount',
        videoDuration: 'short',
        publishedAfter,
        regionCode: 'JP',
        relevanceLanguage: 'ja',
        maxResults: SEARCH_RESULTS_PER_GENRE,
        safeSearch: 'moderate',
      });

      let matched = 0;
      for (const item of data.items || []) {
        const id = item.id?.videoId;
        const title = item.snippet?.title || '';
        const description = item.snippet?.description || '';
        if (!id || videoGenreMap.has(id)) continue;
        if (!containsJapanese(title)) continue;
        if (!matchesKeywords(genre.matchKeywords, title, description)) continue;

        videoGenreMap.set(id, genre.id);
        matched++;
      }
      console.log(`[${genre.id}/JP] ${data.items?.length || 0} 件取得 → ジャンル一致 ${matched} 件`);
    } catch (err) {
      console.error(`[${genre.id}/JP] 検索に失敗: ${err.message}`);
    }
  }

  const prevMap = await readPreviousOutput();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  let pendingCarried = 0;
  for (const [id, prev] of prevMap) {
    if (videoGenreMap.has(id)) continue;
    if (prev.resolvedAt) continue;
    const firstSeenMs = new Date(prev.firstSeenAt || prev.publishedAt).getTime();
    const ageHours = (now - firstSeenMs) / 3600000;
    if (ageHours > PREDICT_PENDING_MAX_HOURS) continue;
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

  const videoDetails = [];
  for (const idsChunk of chunk(videoIds, 50)) {
    const data = await callApi('videos', {
      part: 'snippet,statistics,contentDetails',
      id: idsChunk.join(','),
    });
    videoDetails.push(...(data.items || []));
  }

  const shorts = videoDetails.filter(v => {
    const seconds = parseISODuration(v.contentDetails?.duration || 'PT0S');
    return seconds > 0 && seconds <= 60;
  });
  console.log(`Shorts判定（60秒以下）: ${shorts.length} / ${videoDetails.length} 件`);

  const channelIds = [...new Set(shorts.map(v => v.snippet.channelId))];
  const subscriberMap = new Map();
  for (const idsChunk of chunk(channelIds, 50)) {
    const data = await callApi('channels', {
      part: 'statistics',
      id: idsChunk.join(','),
    });
    for (const item of data.items || []) {
      const subs = item.statistics?.subscriberCount;
      subscriberMap.set(item.id, subs ? Number(subs) : null);
    }
  }

  const videos = shorts
    .map(v => {
      const viewCount = Number(v.statistics?.viewCount || 0);
      const likeCount = Number(v.statistics?.likeCount || 0);
      const commentCount = Number(v.statistics?.commentCount || 0);
      const subscriberCount = subscriberMap.get(v.snippet.channelId);
      const durationSeconds = parseISODuration(v.contentDetails?.duration || 'PT0S');
      const title = v.snippet.title;

      if (subscriberCount === null || subscriberCount === undefined) return null;
      if (subscriberCount < MIN_SUBSCRIBERS) return null;
      if (viewCount < MIN_VIEW_COUNT) return null;

      const growthRatio = Math.round(viewCount / Math.max(subscriberCount, 1));
      const spikeRatio = Number((viewCount / Math.max(subscriberCount, 1)).toFixed(2));
      const estimatedAvgViews = estimateAvgViews(subscriberCount);
      const avgGapMultiplier = Number((viewCount / Math.max(estimatedAvgViews, 1)).toFixed(1));

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

      const genre = videoGenreMap.get(v.id) || 'other';
      const genreMatch = isGenreMatch(title, genre);

      return {
        id: v.id,
        title,
        channelTitle: v.snippet.channelTitle,
        channelId: v.snippet.channelId,
        genre,
        sourceLang: 'ja',
        publishedAt: v.snippet.publishedAt,
        viewCount,
        likeCount,
        commentCount,
        subscriberCount,
        growthRatio,
        spikeRatio,
        durationSeconds,
        estimatedAvgViews,
        avgGapMultiplier,
        buzzKeywords: extractBuzzKeywords(title),
        editTemplates: guessEditTemplate(title),
        audioHint: guessAudioHint(title),
        engagementGrade: estimateEngagementGrade(likeCount, commentCount, viewCount),
        genreSpecialization: genreMatch ? 'same-genre' : 'cross-buzz',
        firstSeenAt,
        firstSeenViewCount,
        predictCheckHours: PREDICT_CHECK_HOURS,
        resolvedTier,
        resolvedAt,
        sixHourGrowthRatio,
        thumbnail: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
      };
    })
    .filter(Boolean);

  console.log(`フィルタ後: ${videos.length} 件`);

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

  const pendingOnly = videos
    .filter(v => !trimmedIds.has(v.id) && !v.resolvedAt)
    .map(v => ({ ...v, predictionOnly: true }));

  const output = [...trimmed, ...pendingOnly];
  output.sort((a, b) => b.growthRatio - a.growthRatio);

  console.log(`最終出力: フィード ${trimmed.length} 件 + 答え合わせ待ち ${pendingOnly.length} 件 = 合計 ${output.length} 件`);
  await writeOutput(output);
}

async function writeOutput(videos) {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    region: 'JP',
    videos,
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(json, null, 2), 'utf-8');
  console.log(`書き込み完了: ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
