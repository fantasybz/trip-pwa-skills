// router.test.ts — caption classification. Run: bun test skills/_lib/router.test.ts
import { test, expect } from 'bun:test';
import { route, MIN_CONFIDENCE, TIE_THRESHOLD, type CorpusName } from './router';

function expectCorpus(caption: string, corpus: CorpusName, minConf = 0.5) {
  const r = route({ caption });
  expect(r.corpus).toBe(corpus);
  expect(r.confidence).toBeGreaterThanOrEqual(minConf);
}

// ---- single-keyword high-confidence (0.95) ----
test('ramen -> food', () => expectCorpus('東京最強豚骨拉麵', 'food', 0.9));
test('sushi -> food', () => expectCorpus('銀座 sushi omakase', 'food', 0.9));
test('unagi -> food', () => expectCorpus('名代 うなぎ 老舗', 'food', 0.9));
test('parfait -> desserts', () => expectCorpus('季節限定パフェ', 'desserts', 0.9));
test('cafe -> desserts', () => expectCorpus('表參道 cafe latte art', 'desserts', 0.9));
test('maritozzo -> desserts', () => expectCorpus('話題のマリトッツォ', 'desserts', 0.9));
test('pokemon -> fandom', () => expectCorpus('Pokemon Center Shibuya 新商品', 'fandom', 0.9));
test('sanrio -> fandom', () => expectCorpus('サンリオ 布丁狗 quku', 'fandom', 0.9));
test('sailor moon (single fandom kw) -> fandom', () => expectCorpus('美少女戰士 グッズ store', 'fandom', 0.9));
test('digital art -> attractions', () => expectCorpus('teamLab デジタルアート 体験', 'attractions', 0.9));
test('museum -> attractions', () => expectCorpus('うんこミュージアム 巡り', 'attractions', 0.9));
test('planetarium -> attractions', () => expectCorpus('コニカミノルタ プラネタリウム', 'attractions', 0.9));
test('shrine -> nearby', () => expectCorpus('明治神社 早朝 散策', 'nearby', 0.9));
test('station -> nearby', () => expectCorpus('新宿駅 南口 集合', 'nearby', 0.9));
test('supermarket -> nearby', () => expectCorpus('業務スーパー まとめ買い', 'nearby', 0.9));

// ---- multi-region Asia (B1: audience = 華語 family beyond Japan) ----
test('HK 點心 -> food', () => expectCorpus('中環 蓮香樓 點心 一盅兩件', 'food', 0.5));
test('HK 車仔麵 -> food', () => expectCorpus('銅鑼灣 文記 車仔麵', 'food', 0.9));
test('HK 燒臘 -> food', () => expectCorpus('油雞 燒臘 飯', 'food', 0.9));
test('Taiwan 滷肉飯 -> food', () => expectCorpus('台北 滷肉飯 牛肉麵', 'food', 0.5));
test('Korea 비빔밥 -> food', () => expectCorpus('명동 비빔밥 맛집', 'food', 0.9));
test('Korea bibimbap (romaji) -> food', () => expectCorpus('Myeongdong bibimbap', 'food', 0.9));
test('SE-Asia pad thai -> food', () => expectCorpus('Bangkok best pad thai', 'food', 0.9));
test('HK egg tart -> desserts', () => expectCorpus('泰昌 蛋撻 出爐', 'desserts', 0.9));
test('Taiwan 珍珠奶茶 -> desserts', () => expectCorpus('珍珠奶茶 創始店', 'desserts', 0.9));
test('Korea 빙수 -> desserts', () => expectCorpus('설빙 빙수', 'desserts', 0.9));
test('HK 港鐵 -> nearby', () => expectCorpus('港鐵 中環站 出口', 'nearby', 0.9));
test('Taiwan 夜市 -> nearby', () => expectCorpus('士林 夜市 必逛', 'nearby', 0.9));

// ---- v0.2.1 Korean food coverage + 시장 de-poach (A2 dogfood Q6) ----
test('광장시장 마약김밥 -> food, NOT nearby (the 시장-poach fix)', () => {
  // 김밥 + 맛집 (food) outscore the lone 시장 (nearby) hit.
  const r = route({ caption: '광장시장 마약김밥 줄서서라도 먹는집 #서울맛집' });
  expect(r.corpus).toBe('food');
});
test('Korean 라멘 spelling -> food', () => expectCorpus('성수동 라멘 맛집 BEST5', 'food', 0.9));
test('분식/김밥/떡볶이 -> food', () => expectCorpus('홍대 분식 김밥 떡볶이', 'food', 0.9));
test('맛집 is a food signal', () => expectCorpus('연남동 파스타 맛집', 'food', 0.5));
test('bare 시장 with no food word stays nearby (market POI, not over-corrected)', () => {
  expect(route({ caption: '광장시장 구경 산책' }).corpus).toBe('nearby');
});
test('카페 + 맛집 -> desserts, NOT food (맛집 generic, Korean dessert vocab wins tie)', () => {
  expect(route({ caption: '성수동 카페 맛집' }).corpus).toBe('desserts');
});
test('케이크 + 맛집 -> desserts', () => {
  expect(route({ caption: '연남동 케이크 맛집' }).corpus).toBe('desserts');
});

// ---- overlapping-keyword dedup (Codex B2: no triple-count) ----
test('寺廟 + 滷肉飯 does not let 寺廟(寺+廟+寺廟) inflate over food', () => {
  const r = route({ caption: '台南 寺廟 滷肉飯' });
  expect(r.corpus).toBe('food');          // food beats nearby on the tie, not nearby-by-inflation
});
test('egg tart counts as one dessert concept, not tart+egg tart', () => {
  expect(route({ caption: '泰昌 egg tart 出爐' }).corpus).toBe('desserts');
});
test('bare BTS does not route to nearby (band, not transit)', () => {
  expect(route({ caption: 'BTS new album release' }).corpus).toBeNull();
});
test('Subway sandwich does not route to nearby', () => {
  expect(route({ caption: 'Subway 三明治 午餐' }).corpus).toBeNull();
});

// ---- ASCII word-boundary (Codex P2: park != parking, tart != start) ----
test('parking does NOT match nearby "park"', () => {
  const r = route({ caption: 'valet parking available downtown' });
  expect(r.corpus).toBeNull();
});
test('start does NOT match dessert "tart"', () => {
  const r = route({ caption: 'the trip will start early' });
  expect(r.corpus).toBeNull();
});

// ---- score-first ranking (Codex P2: 2 food hits beat 1 attraction hit) ----
test('more food hits beat one attraction hit despite priority', () => {
  // 2 food kws (ramen, 寿司) vs 1 attraction kw (museum)
  const r = route({ caption: 'ramen と 寿司 の museum' });
  expect(r.corpus).toBe('food');           // score 2 > 1, not attractions-by-priority
});

// ---- priority breaks SCORE ties (attractions > desserts > fandom) ----
test('equal-score curated tie resolves by priority (attractions > desserts)', () => {
  // 1 attraction kw (体験) + 1 dessert kw (パフェ) → equal score → priority winner
  const r = route({ caption: 'パフェ 体験 イベント' });
  expect(r.corpus).toBe('attractions');
});
test('equal-score tie desserts > fandom', () => {
  const r = route({ caption: 'パフェ と ポケモン コラボ' });   // dessert + fandom equal
  expect(r.corpus).toBe('desserts');
});

// ---- tie flagging ----
test('balanced two-corpus match flags tied_with', () => {
  const r = route({ caption: 'ramen と パフェ' });   // 1 food + 1 dessert, equal
  expect(r.tied_with).toBeDefined();
});

// ---- null / low-confidence no-match ----
test('no keyword -> corpus null, low confidence', () => {
  const r = route({ caption: '今日はいい天気ですね' });
  expect(r.corpus).toBeNull();
  expect(r.confidence).toBeLessThan(MIN_CONFIDENCE);
});
test('empty caption -> corpus null', () => {
  expect(route({ caption: '' }).corpus).toBeNull();
});

// ---- URL is NOT classified (Codex P2) ----
test('keyword in url slug does NOT route', () => {
  const r = route({ caption: 'check this out', url: 'https://site.com/ramen-shop' });
  expect(r.corpus).toBeNull();   // caption has no keyword; url ignored for routing
});

// sanity
test('thresholds sane', () => {
  expect(TIE_THRESHOLD).toBeGreaterThan(0);
  expect(MIN_CONFIDENCE).toBeGreaterThan(TIE_THRESHOLD);
});
