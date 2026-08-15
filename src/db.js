const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'pet-status.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pet_status (
    content_id TEXT PRIMARY KEY,
    acmpy_type_cd TEXT,
    acmpy_psbl_cpam TEXT,
    etc_acmpy_info TEXT,
    updated_at TEXT NOT NULL
  )
`);

// 기존에 만들어진 DB 파일에도 새 컬럼이 반영되도록 존재 여부 확인 후 추가 (SQLite는 ADD COLUMN IF NOT EXISTS를 지원하지 않음)
const petStatusColumns = db.prepare('PRAGMA table_info(pet_status)').all().map((col) => col.name);
if (!petStatusColumns.includes('acmpy_need_mtr')) {
  db.exec('ALTER TABLE pet_status ADD COLUMN acmpy_need_mtr TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS facility_stats (
    content_id TEXT PRIMARY KEY,
    view_count INTEGER NOT NULL DEFAULT 0,
    recommend_count INTEGER NOT NULL DEFAULT 0
  )
`);

// areacode가 비어있는 시설을 addr1 텍스트로 추정한 지역 코드를 캐싱하는 테이블.
// 지역 필터 칩의 개수 표시뿐 아니라 목록 조회 시 재분류된 항목을 채워 넣는 데도 쓰인다.
// scripts/backfill-area-codes.js가 전체 목록을 한 번 훑어서 채워둔다.
db.exec(`
  CREATE TABLE IF NOT EXISTS facility_area (
    content_id TEXT PRIMARY KEY,
    area_code TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const upsertStmt = db.prepare(`
  INSERT INTO pet_status (content_id, acmpy_type_cd, acmpy_psbl_cpam, etc_acmpy_info, acmpy_need_mtr, updated_at)
  VALUES (@contentId, @acmpyTypeCd, @acmpyPsblCpam, @etcAcmpyInfo, @acmpyNeedMtr, @updatedAt)
  ON CONFLICT(content_id) DO UPDATE SET
    acmpy_type_cd = excluded.acmpy_type_cd,
    acmpy_psbl_cpam = excluded.acmpy_psbl_cpam,
    etc_acmpy_info = excluded.etc_acmpy_info,
    acmpy_need_mtr = excluded.acmpy_need_mtr,
    updated_at = excluded.updated_at
`);

function upsertPetStatus(contentId, petItem) {
  upsertStmt.run({
    contentId,
    acmpyTypeCd: petItem?.acmpyTypeCd || null,
    acmpyPsblCpam: petItem?.acmpyPsblCpam || null,
    etcAcmpyInfo: petItem?.etcAcmpyInfo || null,
    acmpyNeedMtr: petItem?.acmpyNeedMtr || null,
    updatedAt: new Date().toISOString(),
  });
}

function getCheckedContentIds() {
  const rows = db.prepare('SELECT content_id FROM pet_status').all();
  return new Set(rows.map((row) => row.content_id));
}

function getPetStatusMap(contentIds) {
  if (contentIds.length === 0) return new Map();

  const placeholders = contentIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM pet_status WHERE content_id IN (${placeholders})`)
    .all(...contentIds);

  return new Map(rows.map((row) => [row.content_id, row]));
}

const incrementViewStmt = db.prepare(`
  INSERT INTO facility_stats (content_id, view_count, recommend_count)
  VALUES (?, 1, 0)
  ON CONFLICT(content_id) DO UPDATE SET view_count = view_count + 1
`);

function incrementViewCount(contentId) {
  incrementViewStmt.run(contentId);
}

const adjustRecommendStmt = db.prepare(`
  INSERT INTO facility_stats (content_id, view_count, recommend_count)
  VALUES (?, 0, MAX(?, 0))
  ON CONFLICT(content_id) DO UPDATE SET
    recommend_count = MAX(recommend_count + ?, 0)
`);

function adjustRecommendCount(contentId, delta) {
  adjustRecommendStmt.run(contentId, delta, delta);
  return db.prepare('SELECT recommend_count FROM facility_stats WHERE content_id = ?').get(contentId)
    ?.recommend_count ?? 0;
}

function getStatsMap(contentIds) {
  if (contentIds.length === 0) return new Map();

  const placeholders = contentIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM facility_stats WHERE content_id IN (${placeholders})`)
    .all(...contentIds);

  return new Map(rows.map((row) => [row.content_id, row]));
}

const upsertFacilityAreaStmt = db.prepare(`
  INSERT INTO facility_area (content_id, area_code, updated_at)
  VALUES (@contentId, @areaCode, @updatedAt)
  ON CONFLICT(content_id) DO UPDATE SET
    area_code = excluded.area_code,
    updated_at = excluded.updated_at
`);

function upsertFacilityArea(contentId, areaCode) {
  upsertFacilityAreaStmt.run({ contentId, areaCode, updatedAt: new Date().toISOString() });
}

function getCheckedAreaContentIds() {
  const rows = db.prepare('SELECT content_id FROM facility_area').all();
  return new Set(rows.map((row) => row.content_id));
}

// 지역코드 -> 재분류된 개수, 그리고 재분류에 성공한 전체 개수
function getInferredAreaCounts() {
  const rows = db.prepare('SELECT area_code, COUNT(*) AS count FROM facility_area GROUP BY area_code').all();
  const byAreaCode = Object.fromEntries(rows.map((row) => [row.area_code, row.count]));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { byAreaCode, total };
}

// 특정 지역으로 재분류된 contentId들 (지역 필터 목록에 끼워 넣을 대상)
function getContentIdsByAreaCode(areaCode) {
  const rows = db.prepare('SELECT content_id FROM facility_area WHERE area_code = ?').all(areaCode);
  return new Set(rows.map((row) => row.content_id));
}

// TourAPI 응답 캐시를 파일 DB에 저장해 서버 재시작(nodemon 등)에도 살아남게 한다.
// 인메모리 캐시(node-cache)는 재시작 때마다 비어서 하루 호출 한도(1,000회)를
// 개발 중 재시작만으로 다 태워버리는 문제가 있었다.
db.exec(`
  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

const getCacheStmt = db.prepare('SELECT value, expires_at FROM api_cache WHERE cache_key = ?');
const setCacheStmt = db.prepare(`
  INSERT INTO api_cache (cache_key, value, expires_at)
  VALUES (@cacheKey, @value, @expiresAt)
  ON CONFLICT(cache_key) DO UPDATE SET
    value = excluded.value,
    expires_at = excluded.expires_at
`);
const deleteCacheStmt = db.prepare('DELETE FROM api_cache WHERE cache_key = ?');

function getCache(key) {
  const row = getCacheStmt.get(key);
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    deleteCacheStmt.run(key);
    return undefined;
  }
  return JSON.parse(row.value);
}

function setCache(key, value, ttlSeconds) {
  setCacheStmt.run({ cacheKey: key, value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
}

module.exports = {
  upsertPetStatus,
  getPetStatusMap,
  getCheckedContentIds,
  incrementViewCount,
  adjustRecommendCount,
  getStatsMap,
  upsertFacilityArea,
  getCheckedAreaContentIds,
  getInferredAreaCounts,
  getContentIdsByAreaCode,
  getCache,
  setCache,
};
