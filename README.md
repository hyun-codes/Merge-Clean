# Color Queue: Desktop Panic

> R/G/B 원색 탄을 FIFO 큐로 받아 인접 동색을 머지해 Y/C/M 특수탄을 만들어 컬러 실드 적을 깨는 2D 탑다운 액션 로그라이트. HTML5 Canvas + Vanilla JS (외부 라이브러리 0). 5스테이지 무한 루프 + 영구 강화 상점 + 듀얼 코어 트윈 보스 피날레.

**2026 DACON 월간 해커톤 출품작**

---

## 🎮 라이브 데모

👉 **[지금 플레이](https://hyun-codes.github.io/Merge-Clean/)**

(GitHub Pages 배포 — 별도 설치 없이 브라우저에서 즉시 플레이 가능)

---

## 🎯 게임 컨셉

큐에 들어온 색은 마음대로 못 바꾼다. **R+G=Y, G+B=C, B+R=M**.
머지의 순서가 곧 전략인 컬러 매칭 액션 로그라이트.

- 적의 방어막 색에 맞는 탄으로 처치
- 잘못된 색을 큐 앞에 두면 보스가 격노
- 영구 강화 + 일시 강화 빌드 다이버시티

---

## ⌨ 컨트롤

| 키 | 동작 |
|:-:|---|
| `WASD` | 이동 |
| `좌클릭` | 사격 (이동 중 사격 가능) |
| `Shift` | 대쉬 (i-frame, 3 스택) |
| `Space` | 큐 앞 2칸 머지 |
| `R` | 큐 앞 1칸 버리기 (pop) |
| `E` | 홀드 슬롯 스왑 |
| `F` | 상호작용 (로비 강화 / 포털) |
| `ESC` | **일시정지 + 옵션 메뉴** (볼륨 슬라이더) |

---

## 🌟 핵심 차별화 포인트

### 1. FIFO 컬러 큐 + 머지 메커닉
- 큐에 들어온 색은 마음대로 못 바꿈 → 순서 자체가 전략
- 인접 동색 머지로 노랑/시안/마젠타 특수탄 생성
- 머지마다 처리 락 (Buffer Optimization 으로 단축 가능)

### 2. 서브셋 컬러 실드 (Subset Matching)
- 단순 동색 매칭이 아닌 **원자 단위 부분집합**
- 노랑(R+G) 탄으로 빨강 / 녹색 / 노랑 실드 모두 격파 가능
- 머지 선택의 깊이 부여

### 3. Glitch 시스템
- 적 처치 ≠ 정리. HP 0 → Glitch 상태로 잔존
- 직접 밟아 `free()` 처리해야 sBit 획득
- 3초 후 enrage 상태로 부활 → 위험 vs 보상

### 4. 무한 루프 + 인플레이션 경제
- 5스테이지 × 3루프 + 보스 3종 + 트윈 보스 피날레
- sBit (런 한정) ↔ cBit (영구) 분리 → 빌드 선택권

### 5. 시네마틱 엔딩
- 3-5 트윈 보스 클리어 시 3단 시퀀스:
  - Cleanse 충격파 (1.5초)
  - 터미널 타이프라이터 (6초)
  - Jackpot 카운트업 통계

---

## 🛠 기술 스택

- **HTML5 Canvas 2D** (rendering)
- **Vanilla JavaScript** (외부 라이브러리 0)
- **Web Audio API** (BGM crossfade + SFX overlap)
- **CSS** (HUD / 오버레이 UI)

**의존성: 0개**

---

## 📁 프로젝트 구조

```
Merge-Clean/
├── index.html              # 진입점
├── main.js                 # 전체 게임 로직 (단일 파일)
├── style.css               # HUD / 오버레이 스타일
├── assets/
│   ├── character/          # 플레이어 스프라이트 시트
│   ├── melee_mob/          # 거미 (근접 적)
│   ├── ranged_mob/         # 드론 (원거리 적)
│   └── sounds/
│       ├── bgm/            # stage / boss / lobby BGM
│       ├── ui/             # click / merge / error / buy SFX
│       ├── player/         # shoot / dash / hit SFX
│       └── monster/        # explode / boss_dash 등 SFX
├── 기획서/                  # 게임 기획서 PDF
└── README.md
```

---

## 🚀 로컬 실행

```bash
git clone https://github.com/hyun-codes/Merge-Clean.git
cd Merge-Clean
# index.html 더블클릭하면 됨 (file:// 프로토콜 호환)
```

브라우저에서 `index.html` 을 직접 열거나, 간단한 정적 서버 사용:
```bash
python -m http.server 8000
# http://localhost:8000 접속
```

---

## 🎬 시연 영상

📺 **[YouTube 데모](https://youtu.be/3RZxZrG7D9I)** 

내용 (1~3분):
- 타이틀 화면 + 컨트롤
- 1-1 → 2-5 일반 / 보스 스테이지 시연
- 3-5 듀얼 코어 트윈 보스
- 시네마틱 엔딩

---

## 🏆 시스템 하이라이트

- ✅ FIFO 큐 + 머지 처리 락
- ✅ Subset 컬러 실드 매칭
- ✅ Glitch / Free / Reassemble 사이클
- ✅ Spider 3종 패턴 (Overflow / Trojan / Leap 3연속)
- ✅ Drone 3종 패턴 (Whip / Spiral / Burst)
- ✅ Twin Boss (Dual Core) — Magenta Collision + 수리 빔 + 폭주
- ✅ Wave Manager (15초 타이머 + 강제 추가 스폰)
- ✅ SoundManager Mixer (BGM crossfade + SFX overlap + Master volume)
- ✅ 시네마틱 엔딩 (Cleanse → Terminal → Jackpot)

---

## 🎨 비주얼 컨셉

**'데스크탑 / 디버그 세계관'**:
- SF 헥사 그리드 홀로그램 실드
- 옥타곤 데이터 코어 포털
- 글리치 와이어프레임 (적 사망 시)
- 타이프라이터 터미널 (엔딩)
- 시안 / 마젠타 사이버펑크 팔레트

---

## 📝 라이선스

이 프로젝트는 2026 DACON 월간 해커톤 출품작입니다.
사용된 모든 에셋 (이미지, 사운드, 폰트) 은 저작권을 준수합니다.
