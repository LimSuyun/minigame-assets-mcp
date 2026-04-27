/**
 * registry-root.ts — `assets-registry.json` / `deploy-map.json` 의 정규 위치 결정
 *
 * 마케팅·로고·썸네일·title-text 등 일부 도구는 자기 sub-dir(`marketing/app-icon` 등)을
 * `outputDir` 로 받는다. 옛 동작은 그 sub-dir 안에 별도 registry/deploy-map 을 만들어
 * 동일 프로젝트의 자산이 여러 파일로 흩어지는 문제가 있었다.
 *
 * 본 헬퍼는 어떤 sub-dir 이 들어오더라도 동일한 "프로젝트 루트(.minigame-assets/)"
 * 한 곳으로 registry / deploy-map 을 모은다.
 */

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";

const ROOT_MARKER_DIR = ".minigame-assets";
const REGISTRY_FILE = "assets-registry.json";
const DEPLOY_MAP_FILE = "deploy-map.json";

/**
 * outputDir 로부터 registry / deploy-map 이 모일 디렉터리를 결정한다.
 *
 * 우선순위:
 *  1. outputDir 또는 그 조상 중 디렉터리명이 ".minigame-assets" 인 첫 번째
 *  2. outputDir 또는 그 조상 중 assets-registry.json / deploy-map.json 이 이미 존재하는 첫 번째
 *  3. DEFAULT_OUTPUT_DIR(`./.minigame-assets`) 의 절대경로가 outputDir 의 prefix 면 그것
 *  4. 위가 모두 실패하면 outputDir 자체 (하위 호환 — 기존 단순 사용 케이스)
 *
 * 반환값은 항상 절대경로.
 */
export function resolveRegistryRoot(outputDir: string): string {
  const abs = path.resolve(outputDir);

  // 1. 이름 기반 — 가장 빠르고 명확한 지표
  let cur = abs;
  while (true) {
    if (path.basename(cur) === ROOT_MARKER_DIR) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 2. 실제 파일 존재로 판정
  cur = abs;
  while (true) {
    if (
      fs.existsSync(path.join(cur, REGISTRY_FILE)) ||
      fs.existsSync(path.join(cur, DEPLOY_MAP_FILE))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 3. DEFAULT_OUTPUT_DIR 절대경로 prefix
  const defaultAbs = path.resolve(DEFAULT_OUTPUT_DIR);
  if (abs === defaultAbs || abs.startsWith(defaultAbs + path.sep)) {
    return defaultAbs;
  }

  // 4. fallback
  return abs;
}
