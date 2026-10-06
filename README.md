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

노선 ID는 `100100391`이다. 서울 버스, 경기 GBIS, ODsay에서 같은 값이다.

## 파일

`data/100100391/<날짜>-<am|pm>.jsonl.gz`. 한 줄이 한 번의 응답이다.

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

키는 공공데이터포털 일반 인증키이고, 저장소의 Secrets `DATA_GO_KR_KEY`에 둔다.

## 출처

공공데이터포털(data.go.kr)의 서울특별시 버스위치정보조회·버스도착정보조회·노선정보조회 서비스, 경기도 버스위치정보 조회 서비스. 이용 조건은 각 서비스 페이지의 이용허락범위를 따른다.
