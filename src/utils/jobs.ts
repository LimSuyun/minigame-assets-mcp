/**
 * jobs.ts
 *
 * 파일 기반 비동기 Job 저장소.
 * 각 Job은 {outputDir}/.jobs/{request_id}.json 에 저장됨.
 *
 * 상태 흐름: processing → done | failed
 */

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_JOBS_DIR } from "../constants.js";
import type { JobRecord, JobStatus } from "../types.js";

export function getJobsDir(outputDir: string = DEFAULT_OUTPUT_DIR): string {
  return path.resolve(outputDir, DEFAULT_JOBS_DIR);
}

export function getJobFilePath(requestId: string, outputDir: string = DEFAULT_OUTPUT_DIR): string {
  return path.join(getJobsDir(outputDir), `${requestId}.json`);
}

function ensureJobsDir(outputDir: string): void {
  const dir = getJobsDir(outputDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 새 Job 생성 — status: "processing"
 */
export function createJob(
  requestId: string,
  toolName: string,
  params?: Record<string, unknown>,
  outputDir: string = DEFAULT_OUTPUT_DIR,
  etaSec?: number
): JobRecord {
  ensureJobsDir(outputDir);
  const now = new Date().toISOString();
  const job: JobRecord = {
    request_id: requestId,
    tool: toolName,
    status: "processing",
    created_at: now,
    updated_at: now,
    params,
    progress: 0,
    message: "Processing...",
    ...(etaSec !== undefined ? { eta_sec: etaSec } : {}),
  };
  fs.writeFileSync(getJobFilePath(requestId, outputDir), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

/**
 * Job 완료 처리 — status: "done"
 */
export function completeJob(
  requestId: string,
  outputPaths: string[],
  result?: unknown,
  outputDir: string = DEFAULT_OUTPUT_DIR
): JobRecord {
  const job = getJob(requestId, outputDir);
  if (!job) {
    throw new Error(`Job not found: ${requestId}`);
  }
  job.status = "done";
  job.output_paths = outputPaths;
  if (result !== undefined) job.result = result;
  job.progress = 100;
  job.message = "Completed";
  job.updated_at = new Date().toISOString();
  delete job.eta_sec;
  fs.writeFileSync(getJobFilePath(requestId, outputDir), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

/**
 * Job 실패 처리 — status: "failed"
 */
export function failJob(
  requestId: string,
  error: string,
  outputDir: string = DEFAULT_OUTPUT_DIR
): JobRecord {
  const job = getJob(requestId, outputDir);
  if (!job) {
    throw new Error(`Job not found: ${requestId}`);
  }
  job.status = "failed";
  job.error = error;
  job.progress = 0;
  job.message = `Failed: ${error}`;
  job.updated_at = new Date().toISOString();
  delete job.eta_sec;
  fs.writeFileSync(getJobFilePath(requestId, outputDir), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

/**
 * Job 진행 상태 업데이트.
 */
export function updateJobProgress(
  requestId: string,
  progress: number,
  message?: string,
  etaSec?: number,
  outputDir: string = DEFAULT_OUTPUT_DIR
): void {
  const job = getJob(requestId, outputDir);
  if (!job) return;
  job.progress = Math.max(0, Math.min(100, progress));
  if (message) job.message = message;
  if (etaSec !== undefined) job.eta_sec = etaSec;
  job.updated_at = new Date().toISOString();
  fs.writeFileSync(getJobFilePath(requestId, outputDir), JSON.stringify(job, null, 2), "utf-8");
}

/**
 * Job 조회.
 */
export function getJob(
  requestId: string,
  outputDir: string = DEFAULT_OUTPUT_DIR
): JobRecord | null {
  const filePath = getJobFilePath(requestId, outputDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as JobRecord;
  } catch {
    return null;
  }
}

/**
 * 모든 Job 목록 반환 (최신순).
 */
export function listJobs(
  outputDir: string = DEFAULT_OUTPUT_DIR,
  statusFilter?: JobStatus
): JobRecord[] {
  const dir = getJobsDir(outputDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const jobs: JobRecord[] = [];

  for (const file of files) {
    try {
      const job = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf-8")
      ) as JobRecord;
      if (!statusFilter || job.status === statusFilter) {
        jobs.push(job);
      }
    } catch {
      // 손상된 파일 스킵
    }
  }

  return jobs.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

/**
 * 완료/실패된 오래된 Job 정리 (기본: 7일).
 */
export function cleanupOldJobs(
  outputDir: string = DEFAULT_OUTPUT_DIR,
  maxAgeDays = 7
): number {
  const dir = getJobsDir(outputDir);
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let removed = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const job = JSON.parse(fs.readFileSync(filePath, "utf-8")) as JobRecord;
      if (
        (job.status === "done" || job.status === "failed") &&
        new Date(job.created_at).getTime() < cutoff
      ) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      // 손상된 파일도 삭제 대상
    }
  }

  return removed;
}

/**
 * 고유 request_id 생성.
 */
export function generateRequestId(toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9]/g, "_");
  return `job_${safe}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
