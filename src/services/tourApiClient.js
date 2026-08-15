const axios = require('axios');
const { getCache, setCache } = require('../db');

// TourAPI 원본 데이터는 자주 안 바뀌므로 캐시로 호출 수를 아낀다.
// (공공데이터포털은 일일 호출 한도가 있음 - 트래픽 늘면 캐시 TTL을 늘리거나 Redis로 교체)
// sqlite에 저장해 서버 재시작(nodemon 등) 후에도 캐시가 유지되도록 한다.
const CACHE_TTL_SECONDS = 60 * 30; // 30분

const client = axios.create({
  baseURL: process.env.TOUR_API_BASE_URL,
  timeout: 8000,
});

/**
 * TourAPI 공통 파라미터를 채워서 오퍼레이션을 호출한다.
 * @param {string} operation - 예: 'areaBasedList1', 'detailCommon1' 등
 *   ⚠️ 실제 신청 승인 후 Swagger 문서에서 정확한 오퍼레이션명을 반드시 확인할 것
 * @param {object} params - 오퍼레이션별 추가 파라미터
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 공공데이터포털이 순간적으로 느려질 때가 있어, 타임아웃/네트워크 오류는
// 1회 재시도한다. TourAPI가 정상 응답한 논리적 오류(잘못된 서비스키 등)는 재시도하지 않는다.
async function requestWithRetry(url, config) {
  try {
    return await client.get(url, config);
  } catch (err) {
    const isTransient = err.code === 'ECONNABORTED' || !err.response;
    if (!isTransient) throw err;
    await sleep(300);
    return client.get(url, config);
  }
}

async function callTourApi(operation, params = {}) {
  const cacheKey = `${operation}:${JSON.stringify(params)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const query = {
    serviceKey: process.env.TOUR_API_SERVICE_KEY,
    MobileOS: process.env.TOUR_API_MOBILE_OS || 'ETC',
    MobileApp: process.env.TOUR_API_MOBILE_APP || 'DongbanHagae',
    _type: 'json',
    numOfRows: 100,
    pageNo: 1,
    ...params,
  };

  const { data } = await requestWithRetry(`/${operation}`, { params: query });

  // TourAPI는 인증키 오류/장애 시에도 200으로 XML/에러 body를 줄 때가 있어 방어적으로 체크
  const header = data?.response?.header;
  if (header && header.resultCode !== '0000') {
    const err = new Error(`TourAPI 오류: ${header.resultCode} ${header.resultMsg}`);
    err.tourApi = header;
    throw err;
  }

  setCache(cacheKey, data, CACHE_TTL_SECONDS);
  return data;
}

module.exports = { callTourApi };
