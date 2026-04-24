# 개발 (소스 직접 수정)

```bash
git clone https://github.com/LimSuyun/minigame-assets-mcp.git
cd minigame-assets-mcp
npm install
npm run build

# 로컬 빌드를 MCP로 등록
claude mcp add minigame-assets \
  -e OPENAI_API_KEY=sk-... \
  -- node /절대경로/minigame-assets-mcp/dist/index.js
```

## 스크립트

```bash
npm run dev        # tsx watch 모드 (핫리로드)
npm run build      # TypeScript 컴파일
npm start          # 빌드된 서버 실행
npm test           # vitest 실행
npm run test:watch # vitest watch 모드
```

## HTTP 모드로 로컬 실행

```bash
TRANSPORT=http PORT=3456 node dist/index.js
```

## 내부 문서

구현 세부사항·설계 노트는 `docs/internals/` 하위에 있습니다.
