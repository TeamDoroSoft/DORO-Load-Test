import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// 전제: 이 스크립트가 겨냥하는 백엔드는 doro.tmap.rate-limit.route-limit-per-minute = 0 으로
// 배포된 환경이어야 한다. RouteResolverService가 Redis rate limiter 단계에서 즉시
// RouteSummary.unavailable("TMAP_RATE_LIMITED")를 반환하고 TmapRouteClient는 호출되지 않는다.
// (운영 값을 직접 바꾸지 말 것 — 부하테스트 전용 프로파일/배포에서만 적용)

const BASE_URL = __ENV.BASE_URL || 'https://doro.beam0331.click';
const TARGET_VU = Number(__ENV.TARGET_VU || 100);

// 팀원 확인(2026-07-24): 운영 RDS의 vehicle_trim_id는 1~203 범위. 필요 시 VEHICLE_TRIM_IDS 환경변수로
// 콤마 구분 목록을 넘기면 그 값을 우선 사용한다.
const VEHICLE_TRIM_IDS = __ENV.VEHICLE_TRIM_IDS
  ? __ENV.VEHICLE_TRIM_IDS.split(',').map(Number)
  : Array.from({ length: 203 }, (_, i) => i + 1);

// 서울 시내 임의 지점 — cacheKey가 origin.toCellKey() 기반이라 지점을 다양화해야 캐시 미스 경로가 고르게 재현됨
const LOCATIONS = [
  { latitude: 37.5665, longitude: 126.978 }, // 서울시청
  { latitude: 37.4979, longitude: 127.0276 }, // 강남역
  { latitude: 37.5547, longitude: 126.9707 }, // 서울역
  { latitude: 37.5172, longitude: 127.0473 }, // 삼성역
  { latitude: 37.6396, longitude: 127.0257 }, // 노원역
];

const routeBlockedAsExpected = new Counter('route_blocked_as_expected');
const routeUnexpectedTmapCall = new Counter('route_unexpected_tmap_call'); // 0이어야 정상 (설정 검증용)
const recommendationDuration = new Trend('recommendation_duration', true);

export const options = {
  scenarios: {
    user_journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: TARGET_VU }, // ramp-up
        { duration: '3m', target: TARGET_VU }, // steady
        { duration: '30s', target: 0 }, // ramp-down
      ],
      exec: 'userJourney',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    recommendation_duration: ['p(95)<1500'],
    route_unexpected_tmap_call: ['count==0'], // TMAP이 실제로 불렸다면 설정이 잘못 적용된 것
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function userJourney() {
  // 1. 앱 진입: 차량 브랜드/트림 목록 조회 (드롭다운 구성)
  const brandsRes = http.get(`${BASE_URL}/api/v1/brands`);
  check(brandsRes, { 'brands 200': (r) => r.status === 200 });

  const trimsRes = http.get(`${BASE_URL}/api/v1/vehicle-trims?size=20`);
  check(trimsRes, { 'vehicle-trims 200': (r) => r.status === 200 });

  // 2. 충전 네트워크(멤버십) 목록 조회
  const networksRes = http.get(`${BASE_URL}/api/v1/charging-networks`);
  check(networksRes, { 'charging-networks 200': (r) => r.status === 200 });

  sleep(1);

  // 3. 충전소 추천 요청 (핵심 API) — MySQL 후보 검색 + Redis 경로 캐시/rate-limit까지만 수행됨
  const payload = JSON.stringify({
    location: pick(LOCATIONS),
    vehicleTrimId: pick(VEHICLE_TRIM_IDS),
    memberNetworkIds: [],
  });
  const params = { headers: { 'Content-Type': 'application/json' } };

  const recRes = http.post(`${BASE_URL}/api/v1/stations/recommendations`, payload, params);
  recommendationDuration.add(recRes.timings.duration);

  const recOk = check(recRes, { 'recommendations 200': (r) => r.status === 200 });
  if (!recOk) {
    sleep(Math.random() * 2 + 1);
    return;
  }

  const body = recRes.json();
  const candidates = body?.data?.candidates || [];

  for (const c of candidates) {
    if (c.route?.status === 'UNAVAILABLE' && c.route?.reasonCode === 'TMAP_RATE_LIMITED') {
      routeBlockedAsExpected.add(1);
    } else if (c.route?.status === 'AVAILABLE') {
      routeUnexpectedTmapCall.add(1);
    }
  }

  // 4. 후보 중 하나 상세 조회 (사용자가 카드 클릭)
  if (candidates.length > 0) {
    const target = pick(candidates);
    const detailRes = http.get(`${BASE_URL}/api/v1/stations/${target.stationId}`);
    check(detailRes, { 'station detail 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 2 + 1);
}
