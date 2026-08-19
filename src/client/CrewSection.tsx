/**
 * `settings.section` 页面：读写本插件的角色小队与流水线配置。
 *
 * 数据完全走 {@link callCrewApi}（本插件自建的 fenced HTTP 路由），不使用
 * `ctx.settingsScope`：`dsh-dev-crew` 命名空间不在 dsh settings RPC 的服务端
 * 白名单内（见 `src/index.ts` 的注释），该 RPC 对本插件的命名空间一律答
 * `settings-not-exposed`。
 *
 * 不呈现任何凭据字段：provider 的密钥归 Models 设置页管，本插件从不读写它们。
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { callCrewApi } from './api.ts'
import type { SkippedRoute } from '../mount.ts'
import type { Config, CrewRole, RoleModel } from '../types.ts'

/** `settings.section` 的 owner 份额：本插件只用得到关闭面板这一个 shell 能力。 */
export interface CrewSectionProps {
  close: () => void
}

/**
 * 一个模型路由在界面上呈现的健康态。
 *
 * `ready`/`unconfigured`/`missing` 三态由宿主的 `/health` 快照决定，`disabled`
 * 由角色自身的 `enabled` 决定，`unknown` 是「宿主还不知道这个配置」——工具名
 * 既不在 `mounted` 也不在 `skipped` 里。最后一态必须与 `missing` 分开：把
 * 「未知」显示成「不存在」是一个错误的确定断言，而刚保存尚未重挂、或本地草稿
 * 尚未提交时都会落到这里。
 */
type DisplayHealth = 'ready' | 'unconfigured' | 'missing' | 'disabled' | 'unknown'

/**
 * 推导一个模型条目对应的工具名。
 *
 * 与 `../mount.ts` 的 `toolNameFor` 保持同一条命名规则：单模型角色为
 * `subagent_<role.id>`，多模型角色为 `subagent_<role.id>_<alias>`。客户端
 * 半部不导入该函数本身，因为它所在模块携带 `@deepseek-ai/schemastery` 等
 * 仅宿主侧可用的运行时依赖；这里复制的是规则，不是权威定义。
 */
function toolNameFor(role: CrewRole, model: RoleModel): string {
  return role.models.length === 1 ? `subagent_${role.id}` : `subagent_${role.id}_${model.alias}`
}

/**
 * 判定一个模型路由的界面健康态。
 * @param role - 草稿中的角色。
 * @param model - 该角色下的模型条目。
 * @param mounted - 宿主当前实际挂载的工具名。
 * @param skipped - 宿主跳过的路由及原因。
 * @returns 该条目的界面健康态；宿主两份快照都不认识这个工具名时为 `unknown`。
 */
export function displayHealth(
  role: CrewRole,
  model: RoleModel,
  mounted: readonly string[],
  skipped: readonly SkippedRoute[],
): DisplayHealth {
  if (!role.enabled) return 'disabled'
  const toolName = toolNameFor(role, model)
  if (mounted.includes(toolName)) return 'ready'
  const entry = skipped.find(candidate => candidate.toolName === toolName)
  if (entry === undefined) return 'unknown'
  return entry.reason === 'unconfigured' ? 'unconfigured' : 'missing'
}

const HEALTH_LABEL: Record<DisplayHealth, string> = {
  ready: '● 就绪',
  unconfigured: '⚠ 未配置',
  missing: '⚠ 不存在',
  disabled: '○ 未启用',
  unknown: '○ 待生效',
}

/**
 * 剔除每个角色的 `persona` 与 `toolFilter`，用于提交前的草稿净化。
 *
 * 界面从不编辑这两个字段，但草稿来自 `/settings.get` 的**已填充**配置——`roles`
 * 的 schema 默认值就是完整的 `BUILTIN_ROLES`，含 persona 与 toolFilter。原样回写
 * 会把内置模板整体物化进用户设置层，此后该角色永久脱离模板演进：0.1.0 的
 * `str_replace_editor` 缺陷正因如此无法通过升级自动修复。
 *
 * 剔除是安全的，因为这两个字段的最终值只有两个来源，都不依赖用户层：组合层
 * （profile 的 cordis.patch.yml）显式写出的值，或 `mount.ts` 按角色 id 填充的内置
 * 模板。用户层留空即落回二者之一，而非落空。
 * @param config - 待提交的草稿。
 * @returns 每个角色都不含 `persona` 与 `toolFilter` 的副本。
 */
export function withoutTemplateFields(config: Config): Config {
  return {
    ...config,
    roles: config.roles.map(({ persona: _persona, toolFilter: _toolFilter, ...rest }) => rest),
  }
}

/** 深拷贝一份配置草稿，使编辑不直接改动已提交的状态。 */
function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config
}

/** 角色小队与流水线配置的读写界面。 */
export function CrewSection(_props: CrewSectionProps): ReactNode {
  const [draft, setDraft] = useState<Config | undefined>(undefined)
  const [revision, setRevision] = useState(0)
  const [mounted, setMounted] = useState<readonly string[]>([])
  const [skipped, setSkipped] = useState<readonly SkippedRoute[]>([])
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  /**
   * 重新拉取宿主的挂载快照。
   *
   * 独立于 `load`，因为保存之后也必须重拉：settings 是 `applies: 'live'`，写入
   * 后宿主立即重挂工具集，而 `mounted`/`skipped` 若停留在页面打开时的那一份，
   * 新配置对应的工具名永远查不到，界面会一直显示保存前的状态。
   */
  const loadHealth = (): Promise<void> =>
    callCrewApi<{ mounted: string[]; skipped: SkippedRoute[] }>('health').then(result => {
      if (result.ok && result.value !== undefined) {
        setMounted(result.value.mounted)
        setSkipped(result.value.skipped)
      }
    })

  const load = (): void => {
    setLoadError(undefined)
    void Promise.all([
      callCrewApi<{ config: Config; revision: number }>('settings.get', {}),
      loadHealth(),
    ]).then(([settingsResult]) => {
      if (!settingsResult.ok || settingsResult.value === undefined) {
        setLoadError(settingsResult.error?.message ?? 'failed to load configuration')
        return
      }
      setDraft(cloneConfig(settingsResult.value.config))
      setRevision(settingsResult.value.revision)
    })
  }

  useEffect(load, [])

  if (draft === undefined) {
    return loadError === undefined
      ? <p>Loading dev-crew configuration…</p>
      : <p role="alert">{loadError}</p>
  }

  const updateRole = (index: number, patch: Partial<CrewRole>): void => {
    setDraft(current => {
      if (current === undefined) return current
      const roles = current.roles.map((role, i) => (i === index ? { ...role, ...patch } : role))
      return { ...current, roles }
    })
  }

  const updateModel = (roleIndex: number, modelIndex: number, patch: Partial<RoleModel>): void => {
    setDraft(current => {
      if (current === undefined) return current
      const roles = current.roles.map((role, i) => {
        if (i !== roleIndex) return role
        const models = role.models.map((model, j) => (j === modelIndex ? { ...model, ...patch } : model))
        return { ...role, models }
      })
      return { ...current, roles }
    })
  }

  const save = (): void => {
    setSaving(true)
    setSaveError(undefined)
    void callCrewApi<{ config: Config; revision: number }>('settings.update', {
      config: withoutTemplateFields(draft),
      expectedRevision: revision,
    }).then(result => {
      setSaving(false)
      if (!result.ok || result.value === undefined) {
        // 保留用户输入：不清空表单，只报告失败原因，允许重试。
        setSaveError(result.error?.code === 'REVISION_CONFLICT'
          ? 'The configuration changed elsewhere since you loaded it. Reload before retrying.'
          : result.error?.message ?? 'failed to save configuration')
        return
      }
      setDraft(cloneConfig(result.value.config))
      setRevision(result.value.revision)
      // 写入已生效，工具集已重挂：重拉快照，否则健康态停留在保存前的那一份。
      void loadHealth()
    })
  }

  return (
    <div>
      <h2>Dev Crew</h2>
      <p>
        Changing a role's enabled state invalidates every session's model cache prefix; the next
        request re-primes it.
      </p>
      <section>
        <h3>Roles</h3>
        {draft.roles.map((role, roleIndex) => (
          <fieldset key={role.id}>
            <legend>{role.id}</legend>
            <label>
              <input
                type="checkbox"
                checked={role.enabled}
                onChange={event => { updateRole(roleIndex, { enabled: event.target.checked }) }}
              />
              enabled
            </label>
            {role.models.map((model, modelIndex) => {
              const health = displayHealth(role, model, mounted, skipped)
              return (
                <div key={model.alias}>
                  <label>
                    provider
                    <input
                      value={model.provider}
                      onChange={event => { updateModel(roleIndex, modelIndex, { provider: event.target.value }) }}
                    />
                  </label>
                  <label>
                    model
                    <input
                      value={model.model}
                      onChange={event => { updateModel(roleIndex, modelIndex, { model: event.target.value }) }}
                    />
                  </label>
                  <span>{HEALTH_LABEL[health]}</span>
                </div>
              )
            })}
          </fieldset>
        ))}
      </section>
      <section>
        <h3>Pipeline</h3>
        <label>
          max convergence rounds
          <input
            type="number"
            min={1}
            max={10}
            value={draft.pipeline.maxConvergenceRounds}
            onChange={event => {
              const value = Number(event.target.value)
              setDraft(current => current === undefined
                ? current
                : { ...current, pipeline: { ...current.pipeline, maxConvergenceRounds: value } })
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.gate.enabled}
            onChange={event => {
              const checked = event.target.checked
              setDraft(current => current === undefined
                ? current
                : { ...current, gate: { ...current.gate, enabled: checked } })
            }}
          />
          discipline gate enabled
        </label>
        <p>Changing this requires a plugin reload to take effect; saving alone does not apply it.</p>
        <p>artifact directories: {draft.artifactDirs.join(', ')}</p>
      </section>
      {saveError !== undefined && <p role="alert">{saveError}</p>}
      <button type="button" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
