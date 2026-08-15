// TourAPI areacode가 비어있는 시설의 addr1(주소 텍스트)을 파싱해서 지역을 추정하고
// facility_area 테이블에 캐싱해두는 스크립트. 지역 필터 칩의 숫자 표시에만 쓰인다.
//
// 목록 조회(areaBasedList2)만 쓰기 때문에 페이지당 1,000건씩 가져와도 전체를 훑는 데
// 10콜 안팎이면 충분해서, 상세조회 백필(backfill-pet-status.js)과 달리 예산 분할 없이
// 한 번에 끝까지 돈다. 그래도 매번 재실행 가능하도록 이미 처리한 곳은 건너뛴다.
//
// 사용법: npm run backfill:area
require('dotenv').config();
const { callTourApi } = require('../src/services/tourApiClient');
const { inferAreaCodeFromAddress } = require('../src/services/addressAreaCode');
const { upsertFacilityArea, getCheckedAreaContentIds } = require('../src/db');

const LIST_PAGE_SIZE = 1000;

async function main() {
  const checked = getCheckedAreaContentIds();
  console.log(`[backfill:area] 이미 추정 완료: ${checked.size}개`);

  let pageNo = 1;
  let scanned = 0;
  let inferred = 0;
  let skippedHasAreaCode = 0;
  let unresolved = 0;

  while (true) {
    const data = await callTourApi('areaBasedList2', {
      numOfRows: LIST_PAGE_SIZE,
      pageNo,
      arrange: 'A',
    });
    const raw = data?.response?.body?.items?.item ?? [];
    const items = Array.isArray(raw) ? raw : [raw].filter(Boolean);
    if (items.length === 0) break;

    for (const item of items) {
      scanned += 1;
      if (item.areacode) {
        skippedHasAreaCode += 1;
        continue;
      }
      if (checked.has(item.contentid)) continue;

      const areaCode = inferAreaCodeFromAddress(item.addr1);
      if (areaCode) {
        upsertFacilityArea(item.contentid, areaCode);
        inferred += 1;
      } else {
        unresolved += 1;
      }
    }

    const totalCount = data?.response?.body?.totalCount ?? 0;
    if (pageNo * LIST_PAGE_SIZE >= totalCount) break;
    pageNo += 1;
  }

  console.log(`[backfill:area] 훑은 항목: ${scanned}개 (원래 areacode 있음: ${skippedHasAreaCode}개)`);
  console.log(`[backfill:area] 새로 추정: ${inferred}개 / 주소로 판별 불가: ${unresolved}개`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill:area] 실행 중 오류:', err);
    process.exit(1);
  });
