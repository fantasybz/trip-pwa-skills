// router.ts — classify a Reel/caption into a content corpus. Pure, synchronous,
// no LLM dependency (v0.1). Ported from 2026-tokyo-family-travel
// scripts/lib/router.ts keyword sets + priority order.
//
// Used by food-ingest and refs-ingest via relative import:
//   import { route, MIN_CONFIDENCE, TIE_THRESHOLD } from '../_lib/router';
//
// Signature locked by eng-review D3; hardened per Codex xhigh (Day 2):
//   - ASCII single-word keywords match on WORD BOUNDARIES (park ≠ parking,
//     tart ≠ start); CJK / multi-word keywords stay substring.
//   - Only the CAPTION is classified; the URL is NOT (its slug/domain caused
//     false positives). The caller uses the url for platform detection only.
//   - corpus is NULLABLE: a zero-match returns corpus:null (not a misleading
//     'food'), so candidates record candidate_for:null = "needs review".
//   - Tie detection ranks by SCORE first (priority only breaks score ties),
//     comparing the winner against the highest-scoring runner-up.

export type CorpusName =
  | 'food' | 'refs' | 'attractions' | 'desserts' | 'fandom' | 'nearby';

export interface RouteResult {
  corpus: CorpusName | null;   // null = no keyword matched (needs human review)
  confidence: number;          // 0.0 - 1.0
  reasons: string[];           // human-readable signals
  tied_with?: CorpusName;      // set when the top-2 scores are within TIE_THRESHOLD
}

// Two corpora whose normalized scores differ by less than this are a "tie" →
// the caller routes to feed_candidates for human placement.
export const TIE_THRESHOLD = 0.1;
// Below this, the caller treats the route as low-confidence → feed_candidates.
export const MIN_CONFIDENCE = 0.4;

// ---- keyword sets (ported from Tokyo router) ----
const DESSERTS_KEYWORDS = [
  // Japan
  '甜點', '甜品', '蛋糕', 'ケーキ', 'カフェ', 'cafe', 'café', 'coffee', 'dessert',
  'sweets', 'parfait', 'パフェ', 'マリトッツォ', 'maritozzo', '鯛魚燒', 'たい焼き',
  '可麗餅', 'クレープ', 'crepe', 'ice cream', 'gelato', 'soft cream', 'ソフトクリーム',
  'puff', 'tart', 'tarte', '和菓子', 'wagashi', 'annin', '杏仁豆腐',
  // HK / Taiwan / Korea / SE-Asia (audience = 華語 family, B1 multi-region)
  '蛋撻', 'egg tart', '楊枝甘露', '燉奶', '雙皮奶', '西多士', '豆花', '芋圓',
  '珍珠奶茶', 'bubble tea', 'boba', '剉冰', '挫冰', '雪花冰', 'shaved ice',
  '빙수', 'bingsu', '호떡', 'hotteok', '糖水', '甜湯', '車輪餅',
  // Korea — dessert/cafe vocab so a "카페 맛집" / "케이크 맛집" ties to desserts
  // (priority desserts > food) instead of the generic FOOD 맛집 winning outright.
  '카페', '디저트', 'dessert', '케이크', '커피', '빵집', '베이커리', '마카롱', '크로플',
];
const FANDOM_KEYWORDS = [
  'pokemon', 'ポケモン', '寶可夢', '皮卡丘', 'ピカチュウ', 'pikachu', 'sanrio',
  'サンリオ', '三麗鷗', '布丁狗', 'pompompurin', 'ポムポムプリン', '美樂蒂',
  'my melody', 'マイメロディ', 'sailor moon', 'セーラームーン', '美少女戰士', '月亮',
  'precure', 'プリキュア', '光美', '光之美少女', 'cardcaptor sakura',
  'カードキャプターさくら', '庫洛魔法使', '庫洛', 'クロウカード', 'clamp', 'kuromi',
  'クロミ', '庫洛米', 'hello kitty', 'ハローキティ', '凱蒂貓',
];
const FOOD_KEYWORDS = [
  // Japan
  '拉麵', 'ラーメン', 'ramen', 'sushi', '寿司', '壽司', '焼肉', '燒肉', 'yakiniku',
  'izakaya', '居酒屋', 'レストラン', 'restaurant', 'tempura', '天ぷら', '天婦羅',
  'うどん', 'udon', 'soba', 'そば', '蕎麥', 'donburi', '丼', '牛丼', '鰻', '鰻魚',
  'うなぎ', '味噌汁', 'miso soup', 'miso', '弁当', 'お弁当', '定食', '食堂',
  // HK / Cantonese
  '燒臘', '叉燒', '燒鵝', '點心', 'dim sum', '飲茶', '一盅兩件', '茶餐廳', '車仔麵',
  '雲吞麵', '菠蘿包', '絲襪奶茶', '打邊爐', '火鍋', 'hotpot', '煲仔飯', '腸粉',
  '魚蛋', '燒味',
  // Taiwan
  '滷肉飯', '魯肉飯', '牛肉麵', '小籠包', '雞排', '鹽酥雞', '蚵仔煎', '臭豆腐',
  '割包', '刈包', '擔仔麵',
  // Korea
  '김치', 'kimchi', '불고기', 'bulgogi', '비빔밥', 'bibimbap', '삼겹살', 'samgyeopsal',
  '떡볶이', 'tteokbokki', '치킨', 'korean fried chicken', '냉면', 'naengmyeon',
  'korean bbq', '韓式',
  // Korea — v0.2.1: the A2 dogfood misrouted 김밥/라멘/맛집 (a market-food Reel
  // hit 시장 in NEARBY and had no FOOD signal). Adding these makes FOOD score
  // win over the 시장 NEARBY hit (a bare 시장 with no food word still → nearby).
  '김밥', 'gimbap', 'kimbap', '라멘', '맛집', '먹방', 'mukbang', '분식', '포차',
  '포장마차', '국밥', '칼국수', '순대', '족발', '보쌈', '곱창', '감자탕', '한식',
  // SE-Asia
  '海南雞飯', 'hainanese chicken', '肉骨茶', 'bak kut teh', 'laksa', '叻沙',
  'pad thai', 'ผัดไทย', '泰式', 'ต้มยำ', 'tom yum', '冬蔭功', 'pho', 'phở', '河粉',
  'bánh mì', 'satay', '沙嗲', 'nasi lemak',
];
const NEARBY_KEYWORDS = [
  // Japan
  '駅', '車站', '神社', 'shrine', '寺', 'temple', 'park', '公園', '展望',
  'observatory', 'skytree', '晴空塔', '夜景', 'スーパー', 'supermarket', 'コンビニ',
  'convenience store', 'ドラッグストア', 'drugstore', '薬局', 'pharmacy', '商店街',
  'shopping street',
  // HK / Taiwan / Korea / SE-Asia. (No bare 'bts' — collides with the band — or
  // 'subway' — collides with the sandwich chain; Codex B2.)
  '港鐵', 'mtr', '捷運', 'mrt', '地鐵', '지하철', '街市', '市場', '市集',
  '夜市', 'night market', '시장', 'skytrain', '廟', '寺廟', '教堂', 'cathedral',
];
const ATTRACTION_KEYWORDS = [
  'museum', '美術館', 'ミュージアム', '博物館', '体験館', '体験', '體驗', '期間限定',
  'ポップアップ', 'pop-up', 'popup', 'フォトスポット', 'photo spot', '写真映え',
  'インスタ映え', 'instagrammable', 'テーマパーク', 'theme park', 'アトラクション',
  'attraction', '限定オープン', 'デジタルアート', 'digital art', 'プラネタリウム',
  'planetarium', '観景台', '観景', '展望台', 'rooftop', 'sky deck', 'オープン',
  '新スポット',
];

// Priority for multi-match when SCORES tie: curated corpora (each its own .json)
// win over candidate-pool corpora (food/nearby). Within curated:
// attractions > desserts > fandom. Within pool: food > nearby.
const PRIORITY: CorpusName[] = ['attractions', 'desserts', 'fandom', 'food', 'nearby'];

const KEYWORDS: Record<Exclude<CorpusName, 'refs'>, string[]> = {
  attractions: ATTRACTION_KEYWORDS,
  desserts: DESSERTS_KEYWORDS,
  fandom: FANDOM_KEYWORDS,
  food: FOOD_KEYWORDS,
  nearby: NEARBY_KEYWORDS,
};

const ASCII_RE = /^[\x00-\x7F]+$/;
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }

// ASCII single-token keyword → word-boundary match (park ≠ parking). Anything
// with CJK or a space → substring match (CJK has no word boundaries).
function matchKeyword(haystackLower: string, kwLower: string): boolean {
  if (ASCII_RE.test(kwLower) && !kwLower.includes(' ')) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(kwLower)}([^a-z0-9]|$)`).test(haystackLower);
  }
  return haystackLower.includes(kwLower);
}

function matchedKeywords(haystack: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const n of needles) {
    if (matchKeyword(haystack, n.toLowerCase())) hits.push(n);
  }
  // Drop a hit that is a substring of another hit in the SAME corpus so a single
  // concept isn't triple-counted (Codex B2: 寺廟 hitting 寺+廟+寺廟, egg tart
  // hitting tart+egg tart). Keeps the longest distinct concepts only.
  const lower = hits.map((h) => h.toLowerCase());
  return hits.filter((h, i) => {
    const hl = lower[i];
    return !lower.some((other, j) => j !== i && other.length > hl.length && other.includes(hl));
  });
}

export function route(input: { caption?: string; url?: string }): RouteResult {
  // Classify the CAPTION only — the URL slug/domain caused false positives.
  const blob = (input.caption ?? '').toLowerCase();

  const scores = new Map<CorpusName, string[]>();
  for (const corpus of PRIORITY) {
    const hits = matchedKeywords(blob, KEYWORDS[corpus as Exclude<CorpusName, 'refs'>]);
    if (hits.length) scores.set(corpus, hits);
  }

  const matched = [...scores.keys()];

  // 0 matches → null corpus (needs human review). Caller → candidates.
  if (matched.length === 0) {
    return { corpus: null, confidence: 0.3, reasons: ['no keyword matched'] };
  }

  // 1 match → high confidence.
  if (matched.length === 1) {
    const corpus = matched[0];
    return {
      corpus,
      confidence: 0.95,
      reasons: [`matched ${corpus}: ${scores.get(corpus)!.join(', ')}`],
    };
  }

  // 2+ matches → rank by SCORE desc, PRIORITY only breaks score ties (Codex P2).
  const ranked = matched.slice().sort((a, b) => {
    const sa = scores.get(a)!.length, sb = scores.get(b)!.length;
    if (sb !== sa) return sb - sa;                         // higher score first
    return PRIORITY.indexOf(a) - PRIORITY.indexOf(b);     // then curated priority
  });
  const winner = ranked[0];
  const runnerUp = ranked[1];                              // highest-scoring non-winner

  const total = matched.reduce((sum, c) => sum + scores.get(c)!.length, 0);
  const winnerNorm = scores.get(winner)!.length / total;
  const runnerNorm = scores.get(runnerUp)!.length / total;
  const tied = (winnerNorm - runnerNorm) < TIE_THRESHOLD;

  const reasons = matched.map((c) => `matched ${c}: ${scores.get(c)!.join(', ')}`);
  reasons.push(`winner ${winner} (score ${scores.get(winner)!.length})${tied ? ` ~ tie with ${runnerUp}` : ''}`);

  return {
    corpus: winner,
    confidence: 0.7,
    reasons,
    ...(tied ? { tied_with: runnerUp } : {}),
  };
}
