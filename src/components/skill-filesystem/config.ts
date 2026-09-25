/**
 * skill-filesystem-plus settings, as the scanner uses them.
 *
 * The values live in the core row's `components["skill-filesystem-plus"]`
 * section; this module only names the subset the scanner reads, so the ported
 * provider stays free of the preset-selection fields.
 *
 * @module @sidleo3/dsh-plugins-plus/skill-filesystem/config
 */

import type { SkillFilesystemConfig } from '../../core/config.ts'

export type { SkillFilesystemConfig }

/** One parent directory name under which `<base>/<name>/skills` is scanned. */
export interface ParentDir {
  /** Directory name (e.g. `.dsh`). */
  readonly name: string
}

/** The scan settings the provider and the watcher consume. */
export type SkillScanConfig = Pick<
  SkillFilesystemConfig,
  'scanCwd' | 'scanProject' | 'scanParents' | 'scanGlobal' | 'parentDirs'
>

/** Fallback used when the bundle service is unavailable. */
export const DEFAULT_SCAN_CONFIG: SkillScanConfig = {
  scanCwd: true,
  scanProject: true,
  scanParents: false,
  scanGlobal: true,
  parentDirs: [{ name: '.dsh' }, { name: '.agents' }],
}
