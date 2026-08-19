const express = require('express');
const rateLimit = require('express-rate-limit');
const { callTourApi } = require('../services/tourApiClient');
const { getAreaCounts, getNativeAreaCount } = require('../services/areaCounts');
const {
  upsertPetStatus,
  getPetStatusMap,
  incrementViewCount,
  adjustRecommendCount,
  getStatsMap,
  getCheckedAreaContentIds,
  getContentIdsByAreaCode,
  insertFacilityReport,
} = require('../db');

const router = express.Router();

// 로그인 없이 버튼 클릭만으로 호출되는 엔드포인트라 봇/스크립트로 recommend_count가
// 쉽게 조작될 수 있다. IP당 분당 요청 수를 제한해 최소한의 어뷰징만 막는다.
const recommendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

// 제보는 자유 텍스트 입력이 있는 폼이라 recommend보다 어뷰징 비용이 크므로 더 낮게 제한한다.
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

// 상세 조회를 한 번이라도 거친 곳은 캐시된 동반 조건/추천·조회수를 목록에도 미리 반영한다.
function enrichItems(items) {
  const contentIds = items.map((item) => item.contentid);
  const statusMap = getPetStatusMap(contentIds);
  const statsMap = getStatsMap(contentIds);

  return items.map((item) => {
    const cached = statusMap.get(item.contentid);
    const stats = statsMap.get(item.contentid);
    return {
      ...item,
      ...(cached && {
        acmpyTypeCd: cached.acmpy_type_cd || item.acmpyTypeCd,
        acmpyPsblCpam: cached.acmpy_psbl_cpam || item.acmpyPsblCpam,
        etcAcmpyInfo: cached.etc_acmpy_info || item.etcAcmpyInfo,
        acmpyNeedMtr: cached.acmpy_need_mtr || item.acmpyNeedMtr,
      }),
      viewCount: stats?.view_count ?? 0,
      recommendCount: stats?.recommend_count ?? 0,
    };
  });
}

// TourAPI에는 "areacode가 비어있는 것만" 필터가 없다. 전체 목록(제목순, 100개씩)을 훑으면서
// areacode가 빈 항목 중 matchId(contentId)를 통과하는 것만 골라 skip/count로 직접 페이지네이션한다.
// arrange='A'(제목순)라 매 요청마다 처음부터 다시 훑어도 같은 순서가 나오고, 훑은 원본 페이지는
// callTourApi의 30분 캐시에 남기 때문에 뒤 페이지를 봐도 실제 TourAPI 호출은 얼마 안 늘어난다.
async function scanBlankAreaItems(matchId, skip, count) {
  const RAW_BATCH_SIZE = 100;

  let rawPage = 1;
  let skipped = 0;
  const collected = [];

  while (collected.length < count) {
    const data = await callTourApi('areaBasedList2', { numOfRows: RAW_BATCH_SIZE, pageNo: rawPage, arrange: 'A' });
    const rawItems = data?.response?.body?.items?.item ?? [];
    const batch = Array.isArray(rawItems) ? rawItems : [rawItems].filter(Boolean);
    if (batch.length === 0) break; // 전체 목록 끝

    for (const item of batch) {
      if (item.areacode) continue; // areacode가 있으면 대상 아님
      if (!matchId(item.contentid)) continue;
      if (skipped < skip) {
        skipped += 1;
      } else {
        collected.push(item);
        if (collected.length >= count) break;
      }
    }

    if (batch.length < RAW_BATCH_SIZE) break; // 마지막 원본 페이지까지 다 훑음
    rawPage += 1;
  }

  return collected;
}

// addr1으로도 지역을 못 찾아 여전히 진짜 미분류로 남은 항목만 골라서 페이지네이션
async function fetchUnclassifiedPage(pageNo, numOfRows) {
  const reclassified = getCheckedAreaContentIds();
  const targetSkip = (pageNo - 1) * numOfRows;
  return scanBlankAreaItems((id) => !reclassified.has(id), targetSkip, numOfRows);
}

/**
 * GET /api/pet-facilities
 * 쿼리: areaCode, sigunguCode, keyword, contentTypeId, pageNo, numOfRows
 *       mapX, mapY, radius (내 주변 검색 - 지정하면 areaCode/keyword보다 우선)
 *       areaCode='unclassified' -> addr1으로도 지역을 못 찾은 진짜 미분류 항목만
 *       areaCode=일반 코드 -> TourAPI 자체 areacode로 걸리는 항목 + addr1으로 재분류된 항목
 * -> 반려동물 동반 가능 시설 목록 조회
 * KorPetTourService2 사용 중 (operation명 접미사는 서비스 버전과 일치해야 함)
 */
router.get('/', async (req, res, next) => {
  try {
    const { areaCode, sigunguCode, keyword, contentTypeId, pageNo, numOfRows, mapX, mapY, radius } = req.query;
    const targetNumOfRows = Number(numOfRows) || 20;

    if (areaCode === 'unclassified') {
      const items = await fetchUnclassifiedPage(Number(pageNo) || 1, targetNumOfRows);
      const areaCounts = await getAreaCounts();

      return res.json({
        totalCount: areaCounts.unclassified ?? 0,
        items: enrichItems(items),
      });
    }

    // 특정 지역 필터 + 다른 조건 없음: TourAPI 자체 areacode로 걸리는 항목(native) 뒤에
    // addr1으로 재분류된 항목(scripts/backfill-area-codes.js가 채워둔 것)을 이어 붙인다.
    // contentTypeId/sigunguCode/keyword/내주변 검색과 조합될 때는 재분류 목록이 그 조건까지
    // 반영하지 못하므로 기존 TourAPI 단독 조회로 둔다.
    if (areaCode && !keyword && !contentTypeId && !sigunguCode && !(mapX && mapY)) {
      const targetPageNo = Number(pageNo) || 1;
      const targetSkip = (targetPageNo - 1) * targetNumOfRows;

      const nativeTotal = await getNativeAreaCount(areaCode);
      const reclassifiedIds = getContentIdsByAreaCode(areaCode);
      const combinedTotal = nativeTotal + reclassifiedIds.size;

      const nativeRemainder = Math.max(0, Math.min(targetNumOfRows, nativeTotal - targetSkip));
      const reclassifiedNeeded = targetNumOfRows - nativeRemainder;

      let items = [];
      if (nativeRemainder > 0) {
        const data = await callTourApi('areaBasedList2', {
          pageNo: targetPageNo,
          numOfRows: targetNumOfRows,
          arrange: 'A',
          areaCode,
        });
        const rawItems = data?.response?.body?.items?.item ?? [];
        items = Array.isArray(rawItems) ? rawItems : [rawItems].filter(Boolean);
      }

      if (reclassifiedNeeded > 0) {
        const reclassifiedSkip = Math.max(0, targetSkip - nativeTotal);
        const reclassifiedItems = await scanBlankAreaItems(
          (id) => reclassifiedIds.has(id),
          reclassifiedSkip,
          reclassifiedNeeded
        );
        items = items.concat(reclassifiedItems);
      }

      return res.json({
        totalCount: combinedTotal,
        items: enrichItems(items),
      });
    }

    let operation;
    let params;

    if (mapX && mapY) {
      // 내 주변 검색: locationBasedList2는 좌표+반경으로 거리순(arrange=E) 정렬된 결과를 준다
      operation = 'locationBasedList2';
      params = {
        pageNo: pageNo || 1,
        numOfRows: targetNumOfRows,
        arrange: 'E',
        mapX,
        mapY,
        radius: radius || 10000,
        ...(contentTypeId && { contentTypeId }),
      };
    } else {
      operation = keyword ? 'searchKeyword2' : 'areaBasedList2';
      params = {
        pageNo: pageNo || 1,
        numOfRows: targetNumOfRows,
        arrange: 'A',
        ...(areaCode && { areaCode }),
        ...(sigunguCode && { sigunguCode }),
        ...(contentTypeId && { contentTypeId }),
        ...(keyword && { keyword }),
      };
    }

    const data = await callTourApi(operation, params);
    const rawItems = data?.response?.body?.items?.item ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems].filter(Boolean);

    res.json({
      totalCount: data?.response?.body?.totalCount ?? 0,
      items: enrichItems(items),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pet-facilities/area-counts
 * -> 지역별(전국 포함) 시설 총 개수. /:contentId 라우트보다 먼저 등록해야
 *    'area-counts'가 contentId로 잘못 매칭되지 않는다.
 */
router.get('/area-counts', async (req, res, next) => {
  try {
    const counts = await getAreaCounts();
    res.json({ counts });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pet-facilities/:contentId
 * -> 시설 상세 정보 (공통정보 + 반려동물 동반 조건)
 * detailCommon2: 이름/주소/개요/좌표
 * detailPetTour2: 동반 가능 구역, 크기 제한, 필수 준수사항 등
 *   ⚠️ detailCommon2는 defaultYN/overviewYN/addrinfoYN/mapinfoYN 파라미터를 받지 않음 (detailCommon1과 다름)
 */
router.get('/:contentId', async (req, res, next) => {
  try {
    const { contentId } = req.params;

    const [common, petInfo] = await Promise.all([
      callTourApi('detailCommon2', { contentId }),
      callTourApi('detailPetTour2', { contentId }).catch(() => null),
    ]);

    const commonRaw = common?.response?.body?.items?.item ?? null;
    const petRaw = petInfo?.response?.body?.items?.item ?? null;
    const commonItem = Array.isArray(commonRaw) ? commonRaw[0] : commonRaw;
    const petItem = Array.isArray(petRaw) ? petRaw[0] : petRaw;

    if (!commonItem) {
      return res.status(404).json({ message: '해당 시설 정보를 찾을 수 없습니다.' });
    }

    // 조회할 때마다 최신 동반 조건으로 캐시를 갱신 -> 다음 목록 조회부터 반영됨
    // petItem이 없어도 "조회는 했음"을 기록해서 백필 스크립트가 같은 곳을 반복 조회하지 않게 함
    upsertPetStatus(contentId, petItem);
    incrementViewCount(contentId);

    const stats = getStatsMap([contentId]).get(contentId);

    res.json({
      common: commonItem,
      pet: petItem,
      stats: {
        viewCount: stats?.view_count ?? 0,
        recommendCount: stats?.recommend_count ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/pet-facilities/:contentId/recommend
 * body: { recommended: boolean } -> true면 +1, false면 -1
 * ⚠️ 로그인 시스템이 없어 브라우저(localStorage) 기준 중복 방지라 완전한 어뷰징 방지는 아님
 */
router.post('/:contentId/recommend', recommendLimiter, (req, res) => {
  const { contentId } = req.params;
  const delta = req.body?.recommended ? 1 : -1;

  const recommendCount = adjustRecommendCount(contentId, delta);
  res.json({ recommendCount });
});

/**
 * POST /api/pet-facilities/:contentId/report
 * body: { message } -> 반려동물 동반 조건 등 정보가 실제와 다르다는 사용자 제보 저장
 * ⚠️ 로그인이 없어 신고자를 특정할 수 없고, 자유 텍스트를 받으므로 길이 제한 + IP 레이트리밋만 적용.
 *    검토/반영은 운영자가 facility_reports 테이블을 직접 확인해 수동으로 처리한다 (관리 화면은 아직 없음).
 */
router.post('/:contentId/report', reportLimiter, (req, res) => {
  const { contentId } = req.params;
  const message = (req.body?.message || '').toString().trim().slice(0, 300);

  if (!message) {
    return res.status(400).json({ message: '제보 내용을 입력해주세요.' });
  }

  insertFacilityReport(contentId, message);
  res.json({ ok: true });
});

module.exports = router;
