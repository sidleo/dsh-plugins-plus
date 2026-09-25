/**
 * agent-instructions-plus settings, as the discovery pipeline uses them.
 *
 * The values live in the core row's `components["agent-instructions-plus"]`
 * section; this module names the subset the pipeline reads and keeps the old
 * cross-field rules (the scan layers are mutually exclusive) in one place.
 *
 * @module @sidleo3/dsh-plugins-plus/agent-instructions/config
 */

import type { AgentInstructionsConfig } from '../../core/config.ts'

export type { AgentInstructionsConfig }

const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** The instruction-discovery settings the pipeline consumes. */
export type InstructionScanConfig = Pick<
  AgentInstructionsConfig,
  | 'scanCwd'
  | 'scanProject'
  | 'scanParents'
  | 'scanGlobal'
  | 'instructionFileCandidates'
  | 'localInstructionFileCandidates'
  | 'projectRootMarkers'
  | 'dshHome'
  | 'maxBytes'
  | 'maxSourceBytes'
>

/** Defaults for a composition that mounts the pipeline without the core row. */
export const DEFAULT_CONFIG: InstructionScanConfig = {
  scanCwd: true,
  scanProject: true,
  scanParents: false,
  scanGlobal: true,
  instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
  localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
  projectRootMarkers: ['.git'],
  dshHome: '~/.dsh',
  maxBytes: 65536,
  maxSourceBytes: 1048576,
}

/**
 * Normalize a settings record into a usable scan configuration.
 *
 * Core normalization happens in the core row; this repeats the cross-field
 * rules for the case where the pipeline is loaded with a plain config (a
 * hand-written preset row, or tests).
 * @param input - settings record from the bundle service or a Loader row.
 * @returns a safe scan configuration.
 */
export function normalizeConfig(input: unknown): InstructionScanConfig {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const scanParents = source.scanParents === true
  return {
    scanCwd: source.scanCwd !== false,
    scanProject: scanParents ? false : source.scanProject !== false,
    scanParents,
    scanGlobal: source.scanGlobal !== false,
    instructionFileCandidates: resolveCandidates(
      source.instructionFileCandidates,
      DEFAULT_CONFIG.instructionFileCandidates,
    ),
    localInstructionFileCandidates: resolveCandidates(
      source.localInstructionFileCandidates,
      DEFAULT_CONFIG.localInstructionFileCandidates,
    ),
    projectRootMarkers: resolveCandidates(source.projectRootMarkers, DEFAULT_CONFIG.projectRootMarkers),
    dshHome:
      typeof source.dshHome === 'string' && source.dshHome.trim().length > 0
        ? source.dshHome.trim()
        : DEFAULT_CONFIG.dshHome,
    maxBytes:
      typeof source.maxBytes === 'number' && Number.isFinite(source.maxBytes)
        ? source.maxBytes
        : DEFAULT_CONFIG.maxBytes,
    maxSourceBytes:
      typeof source.maxSourceBytes === 'number' && Number.isFinite(source.maxSourceBytes)
        ? source.maxSourceBytes
        : DEFAULT_CONFIG.maxSourceBytes,
  }
}

/** Keep candidate names usable as a single file name. */
function resolveCandidates(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && !RESERVED_PATH_SEGMENTS.has(entry) && !/[\\/]/.test(entry))
  return cleaned.length > 0 ? cleaned : [...fallback]
}
