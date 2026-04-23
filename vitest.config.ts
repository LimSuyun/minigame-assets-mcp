import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // 테스트에서 실제 API 호출 없도록 — 외부 의존 테스트는 별도 스크립트로 (scripts/test-*.ts)
    pool: "threads",
  },
});
