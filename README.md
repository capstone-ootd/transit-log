# transit-log

서울 광역버스 9404(분당구미동 ↔ 신사역)의 차량 위치를 평일 출퇴근 시간대에 쌓는 저장소다.
[capstone_ootd](https://github.com/capstone-ootd/capstone_ootd)(정시 도착 지원, 캡스톤디자인)의 배차 간격과 버스 안 시간 분포를 실제 운행에서 얻으려고 만들었다.

## 무엇을 받나

| 구간 (Asia/Seoul, 월~금) | 간격 | API |
|---|---|---|
| 07:00~09:00, 18:30~21:00 | 20초 | 서울 버스위치 `buspos/getBusPosByRtid` — 차량별 GPS 시각, 마지막으로 지난 정류장 순번, 그 정류장에서 온 거리 |
| 같은 구간, 서울 위치와 10초 엇갈려 | 20초 | 경기 버스위치 v2 `getBusLocationListv2` — 차량별 정류장 순번과 도착·출발 상태 |
| 같은 구간 | 60초 | 서울 버스도착 `arrive/getArrInfoByRouteAll` — 정류장별 도착 예측, 만차·혼잡 |
| 실행마다 한 번 | — | 서울 노선정보 `busRouteInfo/getStaionByRoute` — 정류장 목록 |
| 같은 구간 (Secrets `SEOUL_SUBWAY_KEY`가 있을 때) | 2분 | 서울 실시간 지하철 도착 `realtimeStationArrival/ALL` — 수도권 19개 노선 전 역에 다가오는 열차, 진입·도착·출발 상태와 그 시각 (1,000행씩 3쪽) |
| 같은 구간 (같은 조건) | 60초 | 서울 실시간 지하철 위치 `realtimePosition` — 신분당선 열차별 역과 상태 |

노선 ID는 `100100391`이다. 서울 버스, 경기 GBIS, ODsay에서 같은 값이다.

지하철은 경로 엔진이 시간표 그대로 쓰는 구간이 실제로 얼마나 흔들리는지 보려고 10.07에 더했다. 실시간 지하철 키 한도는 일 1,000건이다.

- 위치 조회는 노선 하나씩만 받는다(`신분당선,경강선`처럼 묶으면 데이터 없음). 전 역 도착 정보 ALL은 3번이면 19개 노선이 다 들어오고, 역이 촘촘해 모든 열차가 어느 역엔가 잡힌다. 그래서 ALL을 2분마다 받는다(하루 405건, 행이 3,000을 넘어 4쪽이 되면 540건).
- 코레일 노선(경강선·수인분당선 등)은 `recptnDt`가 열차마다 상태가 바뀐 시각이라 2분 간격이어도 시각이 정확하다.
- 신분당선은 `recptnDt`가 모든 열차에 같은 갱신 시각(약 37초마다)이라 조회 간격이 곧 정밀도다. 재형 경로라서 위치를 60초마다 따로 받는다(하루 270건).
- 합 675건, 많아도 810건이다.

## 파일

`data/100100391/<날짜>-<am|pm>.jsonl.gz`. 한 줄이 한 번의 응답이다.

지하철은 `data/subway/<날짜>-<am|pm>.jsonl.gz`다. 줄은 두 종류다.

- `{"t", "kind": "subwayArr", "total", "items": [...]}`: 전 역 도착 정보. 행마다 `subwayId`(1077 신분당선, 1081 경강선 등), `statnId`, `updnLine`, `btrainNo`(열차 번호), `arvlCd`(0 진입 · 1 도착 · 2 출발 · 3 전역출발 · 4 전역진입 · 5 전역도착 · 99 운행중), `recptnDt`. 쪽마다 따로 받아 쪽 사이 몇 초 차이가 있다. 한 줄이 약 670KB(압축 약 35KB)다.
- `{"t", "kind": "subwayPos", "line": "신분당선", "items": [...]}`: 열차 위치. `trainSttus`는 0 진입 · 1 도착 · 2 출발 · 3 전역출발, `recptnDt`는 그 상태를 받은 시각(KST)이다.

10.07 14:15 시험 파일(`2026-10-07-test-1415`)은 바꾸기 전 방식(두 노선 위치 40초)이다.

```json
{"t":"2026-10-01T22:00:07.066Z","kind":"seoulPos","items":[{"vehId":"113008219","plainNo":"서울74사3676","sectOrd":"6","sectDist":"0","fullSectDist":"0.358","stopFlag":"1","dataTm":"20261002070000", "...": "..."}]}
```

- `t`는 받은 시각(UTC). `kind`는 `stations` · `seoulPos` · `gbisPos` · `seoulArr` · `error`.
- 서울 위치의 `dataTm`은 차량 GPS 시각(KST)이고, 받은 시각보다 10~30초 앞선다.
- 경기 위치에는 차량별 시각이 없다. 응답의 `queryTime`은 서버마다 어긋나 쓰지 않는다.

## 돌리는 법

`.github/workflows/collect.yml`은 수동 실행(workflow_dispatch)으로만 돈다. 시작하면 구간이 열릴 때까지 기다리고, 끝나면 파일을 gzip으로 묶어 커밋한다.
GitHub 예약 실행(schedule)은 쓰지 않는다. 2026-09-30~10-06에 2.5~9시간 늦게 시작해 구간을 모두 놓쳤다.

시작은 [cron-job.org](https://cron-job.org)가 맡는다. 작업 두 개를 만든다.

| 작업 | 시각 (Asia/Seoul) | 본문 |
|---|---|---|
| 9404 am | 월~금 06:50 | `{"ref":"main","inputs":{"slot":"am"}}` |
| 9404 pm | 월~금 18:20 | `{"ref":"main","inputs":{"slot":"pm"}}` |

두 작업 모두 `POST https://api.github.com/repos/capstone-ootd/transit-log/actions/workflows/collect.yml/dispatches`, 헤더는

```
Authorization: Bearer <토큰>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

성공 응답은 `204 No Content`다. 토큰은 GitHub → Settings → Developer settings → Fine-grained tokens에서 이 저장소 하나만 고르고 권한은 **Actions: Read and write** 하나만 준다. cron-job.org에서 실패 알림 메일을 켜 둔다.

손으로 돌릴 때는 Actions → collect → Run workflow, 또는 `gh workflow run collect.yml -R capstone-ootd/transit-log -f slot=pm`. `minutes`를 넣으면 구간과 상관없이 그 시간만큼 받는다.

로컬에서는 Node 24 이상으로:

```bash
DATA_GO_KR_KEY=... node collect.ts am --minutes 5
```

키는 공공데이터포털 일반 인증키이고, 저장소의 Secrets `DATA_GO_KR_KEY`에 둔다. 지하철 키는 서울 열린데이터광장 → 인증키 신청 → **실시간 지하철** 인증키(일반 인증키와 다르다, 신청 즉시 발급)를 Secrets `SEOUL_SUBWAY_KEY`에 둔다. 없으면 지하철만 건너뛴다. 로컬 시험은 `SEOUL_SUBWAY_KEY=sample`로 한 번에 5편성까지 받을 수 있다.

## 출처

공공데이터포털(data.go.kr)의 서울특별시 버스위치정보조회·버스도착정보조회·노선정보조회 서비스, 경기도 버스위치정보 조회 서비스. 이용 조건은 각 서비스 페이지의 이용허락범위를 따른다.
