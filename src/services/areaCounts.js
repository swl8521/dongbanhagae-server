const { callTourApi } = require('./tourApiClient');
const { getInferredAreaCounts, getCache, setCache } = require('../db');

// TourAPI areaCode2 기준 표준 지역 코드 (17개 시/도) + 전국('')
const AREA_CODES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '31', '32', '33', '34', '35', '36', '37', '38', '39'];

// 지역당 1콜씩 총 18콜이 드는 집계라, callTourApi의 30분 캐시보다 훨씬 긴 캐시를 따로 둬서
// 하루 호출 한도(1,000회)를 아낀다. 지역별 시설 수는 자주 안 바뀌는 값이라 12시간이면 충분.
// sqlite에 저장해 서버 재시작(nodemon 등) 후에도 캐시가 유지되도록 한다.
const CACHE_TTL_SECONDS = 60 * 60 * 12;
const CACHE_KEY = 'area-counts';

// 18개 지역을 한꺼번에 동시 호출하면 공공데이터포털이 순간적으로 느려지며
// 타임아웃이 나는 경우가 있어, BATCH_SIZE만큼씩 나눠서 순차적으로 호출한다.
const BATCH_SIZE = 4;

async function fetchAreaCount(areaCode) {
  try {
    const data = await callTourApi('areaBasedList2', {
      numOfRows: 1,
      pageNo: 1,
      arrange: 'A',
      ...(areaCode && { areaCode }),
    });
    return [areaCode, data?.response?.body?.totalCount ?? 0];
  } catch (err) {
    console.error(`[areaCounts] areaCode=${areaCode || '전국'} 조회 실패:`, err.message);
    return [areaCode, 0];
  }
}

async function computeAreaCounts() {
  const entries = [];
  for (let i = 0; i < AREA_CODES.length; i += BATCH_SIZE) {
    const batch = AREA_CODES.slice(i, i + BATCH_SIZE);
    const batchEntries = await Promise.all(batch.map(fetchAreaCount));
    entries.push(...batchEntries);
  }

  // TourAPI에 areacode로 직접 걸리는 개수 (재분류 반영 전). 목록 조회 시 "이 지역은 TourAPI
  // 자체 필터로 몇 개까지 나오고, 그 뒤부터는 우리 DB에서 채워야 하는지" 판단하는 기준이 된다.
  const native = Object.fromEntries(entries);

  // TourAPI 원본 데이터 상당수가 areacode 필드 자체가 비어있어서 어떤 지역 필터로도 안 잡힌다.
  // 전국 총합에서 지역별 합을 빼면 그 "미분류" 개수가 나온다.
  const areaSum = AREA_CODES.filter((code) => code !== '').reduce((sum, code) => sum + native[code], 0);
  const blankTotal = Math.max(native[''] - areaSum, 0);

  // scripts/backfill-area-codes.js가 addr1 텍스트로 미리 추정해둔 지역코드를 칩 숫자/목록에 반영한다.
  const { byAreaCode: inferred, total: inferredTotal } = getInferredAreaCounts();
  const display = { ...native };
  for (const code of AREA_CODES) {
    if (code && inferred[code]) display[code] += inferred[code];
  }
  display.unclassified = Math.max(blankTotal - inferredTotal, 0);

  return { display, native };
}

async function ensureCounts() {
  const cached = getCache(CACHE_KEY);
  if (cached) return cached;

  const computed = await computeAreaCounts();
  setCache(CACHE_KEY, computed, CACHE_TTL_SECONDS);
  return computed;
}

async function getAreaCounts() {
  const { display } = await ensureCounts();
  return display;
}

// 지역 필터 목록 조회 시 "TourAPI 자체 areacode로 몇 개까지 나오는지" 확인하는 용도
async function getNativeAreaCount(areaCode) {
  const { native } = await ensureCounts();
  return native[areaCode] ?? 0;
}

module.exports = { getAreaCounts, getNativeAreaCount };
