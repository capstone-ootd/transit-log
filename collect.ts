// 9404 차량 위치 수집. 출퇴근 시간대에 노선 전 차량의 위치를 두 출처(서울 버스, 경기 GBIS)에서 번갈아 받는다.
// `node collect.ts am|pm [--minutes N]` (Node 24 이상. 타입 표기는 Node가 지우고 실행한다)
//
// am 07:00~09:00, pm 18:30~21:00 (Asia/Seoul). 구간 전에 띄우면 시작 시각까지 기다린다.
// --minutes N은 구간을 무시하고 지금부터 N분 동안 받는다. 파일 이름에 test가 붙는다.
//
// 10초마다 한 번씩: 서울 위치와 경기 위치를 번갈아(각 20초 간격), 60초마다 서울 도착 정보, 실행 시작 때 정류장 목록 한 번.
// 하루 호출은 서울 위치·경기 위치 각 810건, 서울 도착 270건, 정류장 목록 2건으로 개발계정 한도(서비스별 일 1,000건) 안이다.
// 결과는 data/<노선ID>/<날짜>-<am|pm>.jsonl에 한 줄씩 붙인다. 줄마다 kind: stations | seoulPos | gbisPos | seoulArr | error.
//
// SEOUL_SUBWAY_KEY(서울 열린데이터광장 실시간 지하철 인증키)가 있으면 신분당선·경강선 열차 위치도 받는다. 노선마다 40초 간격,
// 하루 405건 × 2노선 = 810건으로 실시간 지하철 키 한도(일 1,000건) 안이다. 시험 실행(--minutes)도 같은 한도를 쓴다.
// 결과는 data/subway/<날짜>-<am|pm>.jsonl, kind: subwayPos(line, items) | error.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';

const ROUTE_ID = '100100391'; // 9404. 서울 busRouteId, 경기 routeId, ODsay busLocalBlID가 같다
const SEOUL = 'http://ws.bus.go.kr/api/rest';
const GBIS_POS = 'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2';
const TICK_MS = 10_000;
const SUBWAY = 'http://swopenapi.seoul.go.kr/api/subway';
const SUBWAY_LINES = ['신분당선', '경강선']; // 재형 10.06 경로. 시간표 그대로 쓰는 지하철 구간이 실제로 얼마나 흔들리는지 본다
const SUBWAY_EVERY = 4; // 틱 4번(40초)마다 노선마다 한 번
const SUBWAY_FIELDS = ['subwayId', 'statnId', 'statnNm', 'statnTid', 'statnTnm', 'trainNo', 'updnLine', 'trainSttus', 'directAt', 'lstcarAt', 'recptnDt', 'lastRecptnDt'];
const WINDOWS: Record<string, [number, number]> = { am: [7 * 60, 9 * 60], pm: [18 * 60 + 30, 21 * 60] };

// 도착 정보는 정류장 60곳 × 95개 필드라 크다. 첫째·둘째 차의 식별, 도착 예측, 혼잡만 남긴다.
const ARR_FIELDS = [
  'staOrd', 'stId', 'arsId', 'term', 'deTourAt', 'mkTm',
  'vehId1', 'plainNo1', 'sectOrd1', 'isArrive1', 'arrmsg1', 'exps1', 'kals1', 'neus1', 'traTime1', 'full1', 'rerdie_Div1', 'reride_Num1', 'brerde_Div1', 'brdrde_Num1',
  'vehId2', 'plainNo2', 'sectOrd2', 'isArrive2', 'arrmsg2', 'exps2', 'kals2', 'neus2', 'traTime2', 'full2', 'rerdie_Div2', 'reride_Num2', 'brerde_Div2', 'brdrde_Num2',
];

type Item = Record<string, unknown>;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 아님 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

async function seoul(path: string, key: string): Promise<Item[]> {
  const qs = new URLSearchParams({ serviceKey: key, busRouteId: ROUTE_ID, resultType: 'json' });
  const body = await fetchJson(`${SEOUL}/${path}?${qs}`);
  if (body.msgHeader?.headerCd !== '0') throw new Error(`${path}: ${body.msgHeader?.headerMsg ?? JSON.stringify(body).slice(0, 200)}`);
  return body.msgBody?.itemList ?? [];
}

async function gbisPos(key: string): Promise<{ queryTime: string; items: Item[] }> {
  const qs = new URLSearchParams({ serviceKey: key, routeId: ROUTE_ID, format: 'json' });
  const body = await fetchJson(`${GBIS_POS}?${qs}`);
  const r = body.response ?? body;
  const code = r.msgHeader?.resultCode;
  // 4는 "결과가 존재하지 않습니다"(운행 차량 없음)
  if (code !== 0 && code !== 4) throw new Error(`gbis: ${r.msgHeader?.resultMessage ?? JSON.stringify(body).slice(0, 200)}`);
  return { queryTime: r.msgHeader?.queryTime ?? '', items: code === 4 ? [] : [].concat(r.msgBody?.busLocationList ?? []) };
}

// 열차 위치(sample 키는 0/5 요청만 받아 시험할 때만 줄인다). trainSttus 0 진입 · 1 도착 · 2 출발 · 3 전역출발, recptnDt는 그 상태를 받은 시각(KST)
async function subwayPos(key: string, line: string): Promise<Item[]> {
  const body = await fetchJson(`${SUBWAY}/${encodeURIComponent(key)}/json/realtimePosition/0/${key === 'sample' ? 5 : 100}/${encodeURIComponent(line)}`);
  const err = body.errorMessage ?? body;
  if (err.code === 'INFO-200') return []; // 해당 데이터 없음(운행 열차 없음)
  if (err.code !== 'INFO-000') throw new Error(`subway ${line}: ${err.code} ${err.message}`);
  return (body.realtimePositionList ?? []).map((i: Item) => pick(i, SUBWAY_FIELDS));
}

function pick(item: Item, fields: string[]): Item {
  const out: Item = {};
  for (const f of fields) if (item[f] !== undefined && item[f] !== null && item[f] !== '') out[f] = item[f];
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const atMinute = (d: Date, m: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60).getTime();

async function main() {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) throw new Error('DATA_GO_KR_KEY 없음');
  const slot = process.argv[2];
  if (!(slot in WINDOWS)) throw new Error('사용법: node collect.ts am|pm [--minutes N]');
  const mi = process.argv.indexOf('--minutes');
  const test = mi > 0;
  const now = new Date();
  const [from, to] = test ? [Date.now(), Date.now() + Number(process.argv[mi + 1]) * 60_000] : WINDOWS[slot].map(m => atMinute(now, m));
  if (Date.now() >= to) {
    console.log(`${slot} 구간이 이미 끝났다`);
    return;
  }

  const dir = `data/${ROUTE_ID}`;
  mkdirSync(dir, { recursive: true });
  // 같은 날 같은 구간을 다시 돌리면 이미 올린 .jsonl.gz를 덮지 않도록 번호를 붙인다
  const base = `${dir}/${ymd(now)}-${test ? `test-${pad(now.getHours())}${pad(now.getMinutes())}` : slot}`;
  let file = `${base}.jsonl`;
  for (let n = 2; existsSync(`${file}.gz`); n++) file = `${base}-${n}.jsonl`;
  const subwayKey = process.env.SEOUL_SUBWAY_KEY;
  const subwayFile = `data/subway/${file.slice(dir.length + 1)}`;
  if (subwayKey) mkdirSync('data/subway', { recursive: true });
  const write = (to: string, row: object) => appendFileSync(to, JSON.stringify(row) + '\n');
  const counts: Record<string, number> = {};
  const attempt = async (kind: string, fn: () => Promise<object>, to = file) => {
    const t = new Date().toISOString();
    try {
      write(to, { t, kind, ...(await fn()) });
      counts[kind] = (counts[kind] ?? 0) + 1;
    } catch (e) {
      write(to, { t, kind: 'error', api: kind, message: e instanceof Error ? e.message : String(e) });
      counts.error = (counts.error ?? 0) + 1;
    }
  };

  if (Date.now() < from) {
    console.log(`${new Date(from).toTimeString().slice(0, 5)}까지 기다린다`);
    await sleep(from - Date.now());
  }
  console.log(`수집 시작 → ${file}${subwayKey ? ` · ${subwayFile}` : ' (SEOUL_SUBWAY_KEY 없음, 지하철은 건너뛴다)'}`);
  await attempt('stations', async () => ({ items: await seoul('busRouteInfo/getStaionByRoute', key) }));

  for (let k = 0; Date.now() < to; k++) {
    const tick = Date.now();
    if (k % 2 === 0) await attempt('seoulPos', async () => ({ items: await seoul('buspos/getBusPosByRtid', key) }));
    else await attempt('gbisPos', () => gbisPos(key));
    if (k % 6 === 0) await attempt('seoulArr', async () => ({ items: (await seoul('arrive/getArrInfoByRouteAll', key)).map(i => pick(i, ARR_FIELDS)) }));
    if (subwayKey && k % SUBWAY_EVERY === 1) {
      for (const line of SUBWAY_LINES) await attempt('subwayPos', async () => ({ line, items: await subwayPos(subwayKey, line) }), subwayFile);
    }
    await sleep(Math.max(0, tick + TICK_MS - Date.now()));
  }
  console.log(`끝. ${JSON.stringify(counts)}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
