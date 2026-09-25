// @ts-nocheck — DSH client modules are plain-JS CJS factories; tsc strict applies to the host side.
/**
 * dsh-plugins-plus browser half.
 *
 * One bundle, one page component, registered in three places so the same
 * configuration is reachable however the user arrives:
 *  - `settings.section`  → a first-class Settings entry ("DSH Plus");
 *  - `plugins.bundle.config` (keyed by package name) → the bundle's page on the
 *    sidebar Plugins page;
 *  - `plugins.row.config` (keyed `<package>#<row id>`) → a Configure control on
 *    each component row, opening that component's card.
 *
 * Every value is read and written through DSH's own configuration pipeline:
 * `ctx.configForms.get(<core row id>)` gives the accepted values, the layer
 * beneath them, the revision to fence a write with, and `mutate`/`unset` for
 * ordered path operations. Nothing here talks to a private file or endpoint;
 * the only fetch is the bundle's read-only status route, which answers which
 * presets exist and what each one currently runs.
 *
 * @module @sidleo3/dsh-plugins-plus/client
 */

import React from 'react'

export const inject = ['slots']

/** Bundle package name; also the `plugins.bundle.config` key. */
const BUNDLE = '@sidleo3/dsh-plugins-plus'
/** Row id of the core plugin that owns the configuration schema. */
const CORE_ROW_ID = 'dsh-plugins-plus'
/** Locale namespace for this page's copy. */
const NS = 'dshPluginsPlus'
/** Read-only host surface. */
const API = '/api/dsh-plugins-plus'

const h = React.createElement
const { useState, useEffect, useMemo, useCallback } = React

/** Component ids in display order, with the row ids the page links to. */
const COMPONENTS = [
  {
    id: 'agent-instructions-plus',
    rowId: 'agent-instructions-plus',
    title: 'agent-instructions-plus',
    subtitle: '替代内置 agent-instructions 的 AGENTS.md 注入',
    kind: 'instructions',
  },
  {
    id: 'skill-filesystem-plus',
    rowId: 'skill-filesystem-plus',
    title: 'skill-filesystem-plus',
    subtitle: '替代内置 skill-filesystem 的技能发现',
    kind: 'skills',
  },
]

const CSS = `
.dppPage{display:flex;flex-direction:column;gap:16px;padding-bottom:16px}
.dppHead{display:flex;flex-direction:column;gap:4px}
.dppTitle{margin:0;font-size:18px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dppIntro{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dppCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dppCardHead{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;background:none;border:0;width:100%;text-align:left;font:inherit;color:inherit}
.dppCardHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:12px}
.dppCardText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dppCardTitle{font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dppCardSub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dppBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 14px;padding:12px 0}
.dppSection{margin-bottom:16px}
.dppSection:last-child{margin-bottom:4px}
.dppSectionTitle{font-size:12.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);margin:0 0 6px}
.dppHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:2px 0 8px}
.dppRow{display:flex;align-items:flex-start;gap:8px;padding:6px 0}
.dppRowMain{flex:1;min-width:0}
.dppLabel{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dppSub{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dppCheck{margin-top:3px;accent-color:var(--dsw-alias-brand-primary)}
.dppInput{padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.dppInput:disabled{opacity:.6}
.dppTextarea{width:100%;box-sizing:border-box;min-height:52px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dppGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
.dppField{display:flex;flex-direction:column;gap:3px;margin:4px 0}
.dppBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 10px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.dppBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dppBtn:disabled{opacity:.45;cursor:default}
.dppBtnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.dppBtnDanger{color:var(--dsw-alias-state-error-primary)}
.dppActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.dppTag{flex:none;font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dppTagOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dppTagWarn{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dppChips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}
.dppChip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;line-height:1.4;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dppChipOn{border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}
.dppChipOff{opacity:.75}
.dppPre{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px;margin:6px 0 0;max-height:200px;overflow:auto;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.dppWarn{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error);margin:6px 0 0}
.dppOk{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);margin:6px 0 0}
.dppEmpty{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dppListRow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dppListRow:last-child{border-bottom:0}
.dppMini{appearance:none;border:0;background:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:2px 4px;flex:none}
.dppMini:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dppMini:disabled{opacity:.4;cursor:default}
.dppRank{flex:none;min-width:20px;text-align:right;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`

/** Inject the page stylesheet once per client graph. */
function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="dsh-plugins-plus/client"]')) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugins-plus'
  tag.dataset.pluginCss = 'dsh-plugins-plus/client'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Clone a configuration value for local editing. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Fetch one read-only answer from the host. */
async function api(path) {
  const res = await fetch(API + path, { headers: { 'content-type': 'application/json' } })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok || (body && body.ok === false)) {
    throw new Error((body && body.error) || `${path} 请求失败（HTTP ${res.status}）`)
  }
  return body
}

/** Subscribe to the core row's configuration form. */
function useConfigForm(ctx) {
  const forms = ctx.get('configForms')
  const form = useMemo(() => (forms ? forms.get(CORE_ROW_ID) : undefined), [forms])
  const [snapshot, setSnapshot] = useState(() => (form ? form.getSnapshot() : undefined))
  useEffect(() => {
    if (!form) return undefined
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => setSnapshot(form.getSnapshot()))
  }, [form])
  return { form, snapshot }
}

/** Read the bundle's status document, with a manual reload. */
function useStatus() {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const reload = useCallback(() => {
    setState(previous => ({ ...previous, loading: true }))
    api('/status')
      .then(data => setState({ loading: false, data, error: null }))
      .catch(error => setState({ loading: false, data: null, error: String(error.message || error) }))
  }, [])
  useEffect(() => {
    reload()
  }, [reload])
  return { ...state, reload }
}

/** Field label plus optional hint. */
function Field(props) {
  return h(
    'label',
    { className: 'dppField' },
    h('span', { className: 'dppLabel' }, props.label),
    props.children,
    props.hint ? h('span', { className: 'dppSub' }, props.hint) : null,
  )
}

/** One checkbox row. */
function Toggle(props) {
  return h(
    'label',
    { className: 'dppRow' },
    h('input', {
      className: 'dppCheck',
      type: 'checkbox',
      checked: props.checked === true,
      disabled: props.disabled === true,
      onChange: event => props.onChange(event.target.checked),
    }),
    h(
      'span',
      { className: 'dppRowMain' },
      h('span', { className: 'dppLabel' }, props.label),
      props.hint ? h('span', { className: 'dppSub' }, props.hint) : null,
    ),
  )
}

/** Editable list of plain strings (file candidates, root markers). */
function StringList(props) {
  return h(
    'div',
    null,
    (props.items || []).map((item, index) =>
      h(
        'div',
        { className: 'dppListRow', key: `${props.id}-${index}` },
        h('input', {
          className: 'dppInput',
          style: { flex: 1, minWidth: 0 },
          value: item,
          disabled: props.disabled,
          onChange: event => props.onChange(index, event.target.value),
        }),
        h('button', {
          type: 'button',
          className: 'dppMini',
          title: '删除',
          disabled: props.disabled,
          onClick: () => props.onRemove(index),
        }, '✕'),
      ),
    ),
    h('button', {
      type: 'button',
      className: 'dppBtn',
      style: { marginTop: 6 },
      disabled: props.disabled,
      onClick: () => props.onAdd(),
    }, props.addLabel || '+ 添加'),
    props.hint ? h('div', { className: 'dppHint' }, props.hint) : null,
  )
}

/** Four scan layers with the mutual-exclusion rule applied on the spot. */
function ScanLayers(props) {
  const value = props.value
  const set = patch => props.onChange({ ...value, ...patch })
  const swap = (key, next) => {
    if (!next) {
      set({ [key]: false })
      return
    }
    if (key === 'scanParents') set({ scanParents: true, scanProject: false })
    else if (key === 'scanProject') set({ scanProject: true, scanParents: false })
    else set({ [key]: true })
  }
  return h(
    'div',
    null,
    h(Toggle, {
      label: '扫描会话工作目录（最高优先级）',
      checked: value.scanCwd,
      disabled: props.disabled,
      onChange: next => set({ scanCwd: next }),
    }),
    h(Toggle, {
      label: '扫描项目根（最近的 .git 祖先）',
      checked: value.scanProject,
      disabled: props.disabled,
      onChange: next => swap('scanProject', next),
      hint: '与「逐级上级」互斥',
    }),
    h(Toggle, {
      label: '逐级扫描所有上级目录（一路到 /）',
      checked: value.scanParents,
      disabled: props.disabled,
      onChange: next => swap('scanParents', next),
      hint: '与「项目根」互斥；跨 git 仓库向上读规则时需要',
    }),
    h(Toggle, {
      label: '扫描用户全局目录（最低优先级）',
      checked: value.scanGlobal,
      disabled: props.disabled,
      onChange: next => set({ scanGlobal: next }),
    }),
  )
}

/** Preset multi-select fed by the host status document. */
function PresetPicker(props) {
  const presets = props.presets || []
  if (presets.length === 0) return h('div', { className: 'dppEmpty' }, '未发现任何 agent 预设。')
  return h(
    'div',
    null,
    presets.map(preset =>
      h(
        'label',
        { className: 'dppRow', key: preset.id },
        h('input', {
          className: 'dppCheck',
          type: 'checkbox',
          checked: (props.selected || []).includes(preset.id),
          disabled: props.disabled === true,
          onChange: event => {
            const next = new Set(props.selected || [])
            if (event.target.checked) next.add(preset.id)
            else next.delete(preset.id)
            props.onChange([...next])
          },
        }),
        h(
          'span',
          { className: 'dppRowMain' },
          h('span', { className: 'dppLabel' }, preset.name ? `${preset.name}（${preset.id}）` : preset.id),
          h(
            'span',
            { className: 'dppSub' },
            preset.broken
              ? `预设不可用：${preset.broken}`
              : `${preset.rowCount} 个插件行${preset.isDefault ? ' · 默认预设' : ''}${preset.overridden ? ' · 已有 profile 覆盖' : ''}`,
          ),
        ),
      ),
    ),
  )
}

/** Preset selection mode selector. */
function ModePicker(props) {
  const options = [
    ['list', '仅勾选的预设'],
    ['all', '所有预设'],
    ['none', '不接管'],
  ]
  return h(
    'div',
    { className: 'dppChips' },
    options.map(([value, label]) =>
      h('button', {
        key: value,
        type: 'button',
        className: 'dppBtn' + (props.value === value ? ' dppBtnPrimary' : ''),
        disabled: props.disabled === true,
        onClick: () => props.onChange(value),
      }, label),
    ),
  )
}

/** Per-preset takeover状态 for one component. */
function TakeoverChips(props) {
  const presets = props.presets || []
  const id = props.componentId
  if (presets.length === 0) return h('div', { className: 'dppEmpty' }, '未发现预设。')
  return h(
    'div',
    { className: 'dppChips' },
    presets.map(preset => {
      const info = (preset.components || {})[id] || {}
      const taking = info.pipeline === true && info.builtinDisabled === true
      const label = preset.name ? `${preset.name}` : preset.id
      return h(
        'span',
        {
          key: preset.id,
          className: 'dppChip ' + (taking ? 'dppChipOn' : 'dppChipOff'),
          title: info.applicable === false
            ? '该预设不含内置行，无需接管'
            : taking
              ? '已接管：内置行已禁用，本插件的行已加入'
              : '未接管：使用内置实现',
        },
        `${taking ? '● ' : '○ '}${label}`,
      )
    }),
  )
}

/** Component parameter editors. */
function ComponentParams(props) {
  const { component, value, disabled, onChange } = props
  const set = patch => onChange({ ...value, ...patch })
  if (component.kind === 'skills') {
    const dirs = value.parentDirs || []
    const move = (index, delta) => {
      const next = [...dirs]
      const target = index + delta
      if (target < 0 || target >= next.length) return
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      set({ parentDirs: next })
    }
    return h(
      'div',
      null,
      h(ScanLayers, { value, disabled, onChange: patch => set(patch) }),
      h(
        'div',
        { className: 'dppSection' },
        h('div', { className: 'dppSectionTitle' }, '上级目录名（扫描 <根>/<名称>/skills）'),
        dirs.map((dir, index) =>
          h(
            'div',
            { className: 'dppListRow', key: `${dir.name}-${index}` },
            h('span', { className: 'dppRank' }, index + 1),
            h('input', {
              className: 'dppInput',
              style: { flex: 1, minWidth: 0 },
              value: dir.name,
              disabled,
              onChange: event => {
                const next = [...dirs]
                next[index] = { name: event.target.value }
                set({ parentDirs: next })
              },
            }),
            h('button', { type: 'button', className: 'dppMini', disabled: disabled || index === 0, title: '上移', onClick: () => move(index, -1) }, '↑'),
            h('button', { type: 'button', className: 'dppMini', disabled: disabled || index === dirs.length - 1, title: '下移', onClick: () => move(index, 1) }, '↓'),
            h('button', {
              type: 'button',
              className: 'dppMini',
              disabled,
              title: '删除',
              onClick: () => set({ parentDirs: dirs.filter((_, position) => position !== index) }),
            }, '✕'),
          ),
        ),
        h('button', {
          type: 'button',
          className: 'dppBtn',
          style: { marginTop: 6 },
          disabled,
          onClick: () => set({ parentDirs: [...dirs, { name: '' }] }),
        }, '+ 添加上级目录'),
        h('div', { className: 'dppHint' }, '靠前优先。默认 .dsh、.agents；留空的名字会被忽略。'),
      ),
    )
  }

  return h(
    'div',
    null,
    h(ScanLayers, { value, disabled, onChange: patch => set(patch) }),
    h(
      'div',
      { className: 'dppSection' },
      h('div', { className: 'dppSectionTitle' }, '指令文件名' ),
      h(StringList, {
        id: 'base',
        items: value.instructionFileCandidates || [],
        disabled,
        addLabel: '+ 添加基础文件名',
        onChange: (index, next) => {
          const items = [...(value.instructionFileCandidates || [])]
          items[index] = next
          set({ instructionFileCandidates: items })
        },
        onAdd: () => set({ instructionFileCandidates: [...(value.instructionFileCandidates || []), ''] }),
        onRemove: index =>
          set({ instructionFileCandidates: (value.instructionFileCandidates || []).filter((_, position) => position !== index) }),
      }),
      h('div', { className: 'dppSectionTitle', style: { marginTop: 10 } }, '本地覆盖文件名'),
      h(StringList, {
        id: 'local',
        items: value.localInstructionFileCandidates || [],
        disabled,
        addLabel: '+ 添加本地覆盖名',
        onChange: (index, next) => {
          const items = [...(value.localInstructionFileCandidates || [])]
          items[index] = next
          set({ localInstructionFileCandidates: items })
        },
        onAdd: () => set({ localInstructionFileCandidates: [...(value.localInstructionFileCandidates || []), ''] }),
        onRemove: index =>
          set({ localInstructionFileCandidates: (value.localInstructionFileCandidates || []).filter((_, position) => position !== index) }),
      }),
      h('div', { className: 'dppSectionTitle', style: { marginTop: 10 } }, '项目根标记'),
      h(StringList, {
        id: 'markers',
        items: value.projectRootMarkers || [],
        disabled,
        addLabel: '+ 添加标记',
        onChange: (index, next) => {
          const items = [...(value.projectRootMarkers || [])]
          items[index] = next
          set({ projectRootMarkers: items })
        },
        onAdd: () => set({ projectRootMarkers: [...(value.projectRootMarkers || []), ''] }),
        onRemove: index =>
          set({ projectRootMarkers: (value.projectRootMarkers || []).filter((_, position) => position !== index) }),
      }),
    ),
    h(
      'div',
      { className: 'dppGrid' },
      h(Field, { label: '全局指令来源目录（dshHome）' },
        h('input', {
          className: 'dppInput',
          value: value.dshHome || '',
          disabled,
          onChange: event => set({ dshHome: event.target.value }),
        })),
      h(Field, { label: '单次注入字节预算（maxBytes）' },
        h('input', {
          className: 'dppInput',
          type: 'number',
          value: String(value.maxBytes || 0),
          disabled,
          onChange: event => set({ maxBytes: Number(event.target.value) || 0 }),
        })),
      h(Field, { label: '单文件读取上限（maxSourceBytes）' },
        h('input', {
          className: 'dppInput',
          type: 'number',
          value: String(value.maxSourceBytes || 0),
          disabled,
          onChange: event => set({ maxSourceBytes: Number(event.target.value) || 0 }),
        })),
    ),
  )
}

/** One component card: enablement, preset source, parameters, takeover status. */
function ComponentCard(props) {
  const { component, status, draft, setDraft, disabled, open, onToggleOpen, onSave, onReset } = props
  const value = (draft && draft.components && draft.components[component.id]) || {}
  const componentStatus = (status && status.components ? status.components : []).find(item => item.id === component.id)
  const presets = (status && status.presets) || []

  const setValue = patch => {
    setDraft(current => ({
      ...current,
      components: { ...(current.components || {}), [component.id]: { ...((current.components || {})[component.id] || {}), ...patch } },
    }))
  }

  const mounted = componentStatus ? componentStatus.mounted === true : false
  const everMounted = componentStatus ? componentStatus.everMounted === true : false
  const inherited = value.useGlobalPresets !== false

  return h(
    'section',
    { className: 'dppCard' },
    h(
      'button',
      { type: 'button', className: 'dppCardHead', onClick: onToggleOpen },
      h(
        'span',
        { className: 'dppCardText' },
        h('span', { className: 'dppCardTitle' }, component.title),
        h('span', { className: 'dppCardSub' }, component.subtitle),
      ),
      h('span', { className: 'dppTag ' + (mounted ? 'dppTagOn' : '') }, mounted ? '已启用' : everMounted ? '已停用' : '未启用'),
      h('span', { className: 'dppMini' }, open ? '⌃' : '⌄'),
    ),
    open
      ? h(
          'div',
          { className: 'dppBody' },
          h(
            'div',
            { className: 'dppSection' },
            h('div', { className: 'dppSectionTitle' }, '生效范围（agent 预设）'),
            h(
              'div',
              { className: 'dppChips' },
              h('button', {
                type: 'button',
                className: 'dppBtn' + (inherited ? ' dppBtnPrimary' : ''),
                disabled,
                onClick: () => setValue({ useGlobalPresets: true }),
              }, '继承全局'),
              h('button', {
                type: 'button',
                className: 'dppBtn' + (inherited ? '' : ' dppBtnPrimary'),
                disabled,
                onClick: () => setValue({ useGlobalPresets: false }),
              }, '单独指定'),
            ),
            inherited
              ? h('div', { className: 'dppHint' }, '使用「全局配置」里的预设选择。')
              : h(
                  'div',
                  null,
                  h(ModePicker, {
                    value: value.presetsMode || 'list',
                    disabled,
                    onChange: next => setValue({ presetsMode: next }),
                  }),
                  (value.presetsMode || 'list') === 'list'
                    ? h(PresetPicker, {
                        presets,
                        selected: value.presets || [],
                        disabled,
                        onChange: next => setValue({ presets: next }),
                      })
                    : null,
                ),
          ),
          h(
            'div',
            { className: 'dppSection' },
            h('div', { className: 'dppSectionTitle' }, '组件参数'),
            h(ComponentParams, { component, value, disabled, onChange: setValue }),
          ),
          h(
            'div',
            { className: 'dppSection' },
            h('div', { className: 'dppSectionTitle' }, '当前接管状态'),
            h(TakeoverChips, { componentId: component.id, presets }),
            mounted
              ? null
              : h('div', { className: 'dppHint' }, '组件未启用：接管不会生效。可在侧栏「插件」页把该行打开。'),
          ),
          h(
            'div',
            { className: 'dppActions' },
            h('button', { type: 'button', className: 'dppBtn dppBtnPrimary', disabled, onClick: onSave }, '保存'),
            h('button', { type: 'button', className: 'dppBtn', disabled, onClick: onReset }, '恢复默认（清除覆盖）'),
          ),
        )
      : null,
  )
}

/** The whole page, shared by the Settings section and both Plugins-page slots. */
function DshPlusPage(props) {
  const { ctx, mode, focus } = props
  const { form, snapshot } = useConfigForm(ctx)
  const status = useStatus()
  // Seed the draft during the FIRST render when the host answer is already in
  // the mirror (the page therefore never paints an empty configuration), and
  // re-seed whenever the accepted document moves: our own save, a write from
  // another surface, or the first read landing.
  const [draft, setDraft] = useState(() => (snapshot && snapshot.value ? clone(snapshot.value) : null))
  const [openIds, setOpenIds] = useState(() => (focus ? [focus] : ['global']))
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)

  const revision = snapshot ? snapshot.revision : undefined
  const ready = snapshot ? snapshot.status === 'ready' : false
  const writable = snapshot ? snapshot.writable === true : false

  // Re-seed the draft whenever the accepted document moves (our own save, a
  // write from another surface, or a first read that arrived after mount).
  useEffect(() => {
    setDraft(snapshot && snapshot.value ? clone(snapshot.value) : null)
  }, [revision, snapshot && snapshot.status])

  const apply = useCallback(
    async operations => {
      if (!form) {
        setError('配置命名空间不可用：核心行未启用，或该部署不提供设置服务。')
        return false
      }
      setBusy(true)
      setError(null)
      setMessage(null)
      try {
        const accepted = await form.mutate(operations, revision)
        if (!accepted) {
          setError('保存被拒绝：配置已被别处改动，已重新读取，请重试。')
        } else {
          setMessage('已保存')
        }
        return accepted
      } catch (failure) {
        setError(String((failure && failure.message) || failure))
        return false
      } finally {
        setBusy(false)
      }
    },
    [form, revision],
  )

  const saveGlobal = () =>
    apply([
      { op: 'set', path: ['presetsMode'], value: draft.presetsMode || 'list' },
      { op: 'set', path: ['presets'], value: draft.presets || [] },
    ])

  const saveComponent = componentId => {
    const value = (draft.components || {})[componentId]
    const component = COMPONENTS.find(item => item.id === componentId)
    const patch = clone(value)
    if (component && component.kind === 'skills' && Array.isArray(patch.parentDirs)) {
      patch.parentDirs = patch.parentDirs.filter(dir => dir && typeof dir.name === 'string' && dir.name.trim().length > 0)
      if (patch.parentDirs.length === 0) delete patch.parentDirs
    }
    return apply([{ op: 'set', path: ['components', componentId], value: patch }])
  }

  const resetComponent = componentId => apply([{ op: 'unset', path: ['components', componentId] }])

  const reconcileNow = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await api('/reconcile')
      const written = result.report ? result.report.written : 0
      setMessage(written > 0 ? `已应用：写入 ${written} 个预设` : '已应用：无需改动')
      status.reload()
    } catch (failure) {
      setError(String((failure && failure.message) || failure))
    } finally {
      setBusy(false)
    }
  }

  const loadPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await api('/roots'))
    } catch (failure) {
      setError(String((failure && failure.message) || failure))
    } finally {
      setBusy(false)
    }
  }

  const toggleOpen = id => {
    setOpenIds(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
  }

  const disabled = !ready || !writable || busy
  const presets = (status.data && status.data.presets) || []
  const report = status.data && status.data.report
  const migration = status.data && status.data.migration

  return h(
    'div',
    { className: 'dppPage' },
    mode === 'section'
      ? h(
          'div',
          { className: 'dppHead' },
          h('h2', { className: 'dppTitle' }, 'DSH Plus'),
          h('p', { className: 'dppIntro' }, '内置插件的增强替代：每个组件可单独开关，按 agent 预设接管。配置写入当前 profile 的 cordis.patch.yml。'),
        )
      : null,

    !ready
      ? h(
          'div',
          { className: 'dppCard' },
          h('div', { className: 'dppBody' },
            h('div', { className: 'dppHint' },
              snapshot === undefined
                ? '设置服务不可用：本部署没有提供 configForms。'
                : snapshot.status === 'loading'
                  ? '正在读取配置…'
                  : '配置命名空间不可用：请确认侧栏「插件」页里的 dsh-plugins-plus 行已启用。'),
          ),
        )
      : null,

    mode === 'section' && status.loading
      ? h('div', { className: 'dppEmpty' }, '正在读取预设状态…')
      : null,
    status.error ? h('div', { className: 'dppWarn' }, `状态读取失败：${status.error}`) : null,

    h(
      'section',
      { className: 'dppCard' },
      h(
        'button',
        { type: 'button', className: 'dppCardHead', onClick: () => toggleOpen('global') },
        h('span', { className: 'dppCardText' },
          h('span', { className: 'dppCardTitle' }, '全局配置'),
          h('span', { className: 'dppCardSub' }, '所有组件的默认接管范围；组件可单独覆盖。'),
        ),
        h('span', { className: 'dppTag' }, `${presets.length} 个预设`),
        h('span', { className: 'dppMini' }, openIds.includes('global') ? '⌃' : '⌄'),
      ),
      openIds.includes('global') && draft
        ? h(
            'div',
            { className: 'dppBody' },
            h('div', { className: 'dppSectionTitle' }, '接管哪些 agent 预设'),
            h(ModePicker, {
              value: draft.presetsMode || 'list',
              disabled,
              onChange: next => setDraft(current => ({ ...current, presetsMode: next })),
            }),
            (draft.presetsMode || 'list') === 'list'
              ? h(PresetPicker, {
                  presets,
                  selected: draft.presets || [],
                  disabled,
                  onChange: next => setDraft(current => ({ ...current, presets: next })),
                })
              : null,
            h('div', { className: 'dppHint' },
              '接管 = 在该预设的组合里禁用内置行、加入本插件的行；取消后内置实现自动恢复。改动影响之后新建的会话。'),
            h('div', { className: 'dppActions' },
              h('button', { type: 'button', className: 'dppBtn dppBtnPrimary', disabled, onClick: saveGlobal }, '保存全局配置'),
              h('button', { type: 'button', className: 'dppBtn', disabled: busy, onClick: reconcileNow }, '立即应用'),
            ),
          )
        : null,
    ),

    draft
      ? COMPONENTS.map(component =>
          h(ComponentCard, {
            key: component.id,
            component,
            status: status.data,
            draft,
            setDraft,
            disabled,
            open: openIds.includes(component.id) || openIds.includes(component.rowId),
            onToggleOpen: () => toggleOpen(component.id),
            onSave: () => saveComponent(component.id),
            onReset: () => resetComponent(component.id),
          }),
        )
      : null,

    h(
      'section',
      { className: 'dppCard' },
      h(
        'button',
        { type: 'button', className: 'dppCardHead', onClick: () => toggleOpen('preview') },
        h('span', { className: 'dppCardText' },
          h('span', { className: 'dppCardTitle' }, '扫描根预览'),
          h('span', { className: 'dppCardSub' }, '按当前 skills 配置，对最近使用的工作目录会扫哪些目录。'),
        ),
        h('span', { className: 'dppMini' }, openIds.includes('preview') ? '⌃' : '⌄'),
      ),
      openIds.includes('preview')
        ? h(
            'div',
            { className: 'dppBody' },
            h('button', { type: 'button', className: 'dppBtn', disabled: busy, onClick: loadPreview }, '读取扫描根'),
            preview
              ? h('div', { className: 'dppPre' },
                  `cwd: ${preview.cwd}\n` +
                    (preview.roots || [])
                      .map(root => `${String(root.rank).padStart(3, ' ')}  ${root.source.padEnd(16, ' ')} ${root.root}`)
                      .join('\n'))
              : null,
          )
        : null,
    ),

    report || migration
      ? h(
          'div',
          { className: 'dppPre' },
          report
            ? `上次应用（${report.at}，原因 ${report.reason}）：写入 ${report.written} 个预设；已挂载组件 ${(report.mounted || []).join(', ') || '无'}\n` +
              (report.entries || [])
                .filter(entry => entry.action === 'write' || entry.error)
                .map(entry => `  ${entry.presetId}: ${entry.error ? '失败 ' + entry.error : '已更新 ' + (entry.activeComponents || []).join(', ')}`)
                .join('\n') +
              ((report.problems || []).length > 0 ? '\n  提示：' + report.problems.join('；') : '')
            : '',
          migration ? `\n迁移：\n  ${(migration.notes || []).join('\n  ')}${migration.error ? `\n  失败：${migration.error}` : ''}` : '',
        )
      : null,

    message ? h('div', { className: 'dppOk' }, `✓ ${message}`) : null,
    error ? h('div', { className: 'dppWarn' }, `✕ ${error}`) : null,
  )
}

/** Wrap a page in the plugin context so hooks can reach the services. */
function page(ctx, mode, focus) {
  return function DshPlusSlot() {
    return h(DshPlusPage, { ctx, mode, focus })
  }
}

/**
 * Register the page in every surface this DSH version offers.
 * @param ctx - the client plugin context.
 */
export function apply(ctx) {
  injectStyles()
  const slots = ctx.get('slots')
  if (slots === undefined) {
    console.warn('[dsh-plugins-plus] slots service unavailable — configuration page not registered')
    return
  }

  const locale = ctx.get('locale')
  if (locale && typeof locale.register === 'function') {
    try {
      locale.register(NS, {
        en: { nav: 'DSH Plus', bundle: 'DSH Plus' },
        zh: { nav: 'DSH Plus', bundle: 'DSH Plus' },
      })
    } catch {
      // A duplicate registration only means another copy of this page is mounted.
    }
  }

  // Settings → a first-class section of its own.
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-plugins-plus', order: 60, label: 'DSH Plus', locale: NS },
      page(ctx, 'section'),
    ))

  // Sidebar Plugins → this bundle's page (keyed by package name).
  slots.inject('plugins.bundle.config', () =>
    slots.register(
      { name: 'plugins.bundle.config', key: BUNDLE, locale: NS },
      page(ctx, 'bundle'),
    ))

  // Sidebar Plugins → one Configure page per component row.
  for (const component of COMPONENTS) {
    slots.inject('plugins.row.config', () =>
      slots.register(
        { name: 'plugins.row.config', key: `${BUNDLE}#${component.rowId}`, locale: NS },
        page(ctx, 'row', component.id),
      ))
  }
  // The core row's own Configure page shows the global section plus both cards.
  slots.inject('plugins.row.config', () =>
    slots.register(
      { name: 'plugins.row.config', key: `${BUNDLE}#${CORE_ROW_ID}`, locale: NS },
      page(ctx, 'row'),
    ))
}
