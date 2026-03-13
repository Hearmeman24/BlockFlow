export interface Job {
  job_id: string
  endpoint_id: string
  status: 'QUEUED' | 'SUBMITTING' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_WARNING' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  remote_status: string | null
  remote_job_id: string | null
  video_url: string | null
  local_video_url: string | null
  local_file: string | null
  seed: number | null
  error: string | null
  warning: string | null
  elapsed_seconds: number | null
  runpod_progress: RunPodProgress | null
  created_at: number
  updated_at: number
  request: JobRequest
  endpoint_reported_resolution: { width: number; height: number } | null
  endpoint_reported_frames: number | null
  endpoint_reported_fps: number | null
  actual_resolution: { width: number; height: number } | null
  actual_frames: number | null
  actual_fps: number | null
  actual_source: string | null
}

export interface RunPodProgress {
  message?: string
  percent?: number
  stage?: string
  step?: number
  total_steps?: number
  eta_seconds?: number
  avg_step_seconds?: number
  elapsed_seconds?: number
}

export interface JobRequest {
  prompt: string
  resolution: { width: number; height: number } | string
  width: number
  height: number
  frames: number
  fps: number
  seed_mode: 'random' | 'fixed'
  requested_seed: number | null
  loras: LoraEntry[]
  negative_prompt: string
  // sent_payload fields for debugging
  sent_payload_resolution: unknown
  sent_payload_width: number
  sent_payload_height: number
  sent_payload_target_width: number
  sent_payload_target_height: number
  sent_payload_target_video_length: number
}

export interface LoraEntry {
  name: string
  branch: 'high' | 'low' | 'both'
  strength: number
}

export interface WriterSettings {
  system_prompt: string
  model: string
  temperature: number
  max_tokens: number
}

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number | null
  modality: string | null
  input_modalities: string[]
  output_modalities: string[]
}

export interface LoraData {
  ok: boolean
  high: string[]
  low: string[]
  from_cache: boolean
  warning?: string
  error?: string
  source?: {
    target: string
    high_dir: string
    low_dir: string
  }
}

export interface GeneratePayload {
  endpoint_id: string
  prompt: string
  width: number
  height: number
  frames: number
  fps: number
  parallel_count: number
  seed_mode: 'random' | 'fixed'
  seed: number
  loras?: LoraEntry[]
}

export interface PromptGeneratePayload {
  model: string
  system_prompt: string
  user_prompt: string
  temperature: number
  max_tokens: number
}

// ---- Run History ----

export interface BlockResult {
  block_index: number
  block_type: string
  block_label: string
  status: string
  outputs: Record<string, { kind: string; value: unknown }>
}

export interface RunEntry {
  id: string
  name: string
  status: 'completed' | 'partial' | 'failed'
  duration_ms: number
  flow_snapshot: Record<string, unknown>
  block_results: BlockResult[]
  created_at: string
}

export type JobStatus = Job['status']

export const TERMINAL_STATUSES: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED_WITH_WARNING']
export const ACTIVE_STATUSES: JobStatus[] = ['QUEUED', 'SUBMITTING', 'RUNNING']
