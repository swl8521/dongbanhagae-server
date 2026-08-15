// TourAPI 일일 호출 한도(기본 1,000회) 안에서 전체 시설의 반려동물 동반 조건을
// 조금씩 나눠 미리 조회해 DB에 채워두는 스크립트.
// 이미 조회한 contentId는 pet_status 테이블에 남아있으므로, 매일 실행해도
// 자동으로 이어서 진행된다 (완료된 곳은 건너뜀).
//
// 사용법: npm run backfill [-- 700]   (예산 미지정 시 기본 700회)
require('dotenv').config();
const { callTourApi } = require('../src/services/tourApiClient');
const { upsertPetStatus, getCheckedContentIds } = require('../src/db');

const BUDGET = Number(process.argv[2] || process.env.BACKFILL_BUDGET || 700);
const DELAY_MS = 150;
const LIST_PAGE_SIZE = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrap(item) {
  return Array.isArray(item) ? item[0] : item;
}

async function collectAllContentIds() {
  const ids = [];
  let pageNo = 1;

  while (true) {
    const data = await callTourApi('areaBasedList2', {
      numOfRows: LIST_PAGE_SIZE,
      pageNo,
      arrange: 'A',
    });
    const raw = data?.response?.body?.items?.item ?? [];
    const items = Array.isArray(raw) ? raw : [raw].filter(Boolean);
    if (items.length === 0) break;

    ids.push(...items.map((item) => item.contentid));

    const totalCount = data?.response?.body?.totalCount ?? 0;
    if (pageNo * LIST_PAGE_SIZE >= totalCount) break;
    pageNo += 1;
  }

  return ids;
}

async function main() {
  console.log(`[backfill] 이번 실행 예산: ${BUDGET}회`);

  console.log('[backfill] 전체 시설 목록 수집 중...');
  const allIds = await collectAllContentIds();
  console.log(`[backfill] 전체 ${allIds.length}개 확인`);

  const checked = getCheckedContentIds();
  const pending = allIds.filter((id) => !checked.has(id));
  console.log(`[backfill] 이미 조회 완료: ${checked.size}개 / 남은 항목: ${pending.length}개`);

  const targets = pending.slice(0, BUDGET);
  console.log(`[backfill] 이번 실행에서 ${targets.length}개 조회 예정`);

  let done = 0;
  for (const contentId of targets) {
    try {
      const petData = await callTourApi('detailPetTour2', { contentId });
      const petItem = unwrap(petData?.response?.body?.items?.item ?? null);
      upsertPetStatus(contentId, petItem);
      done += 1;
    } catch (err) {
      console.error(`[backfill] ${contentId} 조회 실패: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  const remaining = pending.length - done;
  console.log(`[backfill] 완료: ${done}개 처리. 남은 항목: ${remaining}개`);
  if (remaining > 0) {
    console.log('[backfill] 내일 다시 실행하면 이어서 진행됩니다.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] 실행 중 오류:', err);
    process.exit(1);
  });
