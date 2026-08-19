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

/** 一个模型路由在界面上呈现的三态健康 + 未启用第四态。 */
type DisplayHealth = 'ready' | 'unconfigured' | 'missing' | 'disabled'

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

/** 判定一个模型路由的界面健康态。 */
function displayHealth(
  role: CrewRole,
  model: RoleModel,
  mounted: readonly string[],
  skipped: readonly SkippedRoute[],
): DisplayHealth {
  if (!role.enabled) return 'disabled'
  const toolName = toolNameFor(role, model)
  if (mounted.includes(toolName)) return 'ready'
  const entry = skipped.find(candidate => candidate.toolName === toolName)
  return entry?.reason === 'unconfigured' ? 'unconfigured' : 'missing'
}

const HEALTH_LABEL: Record<DisplayHealth, string> = {
  ready: '● 就绪',
  unconfigured: '⚠ 未配置',
  missing: '⚠ 不存在',
  disabled: '○ 未启用',
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

  const load = (): void => {
    setLoadError(undefined)
    void Promise.all([
      callCrewApi<{ config: Config; revision: number }>('settings.get', {}),
      callCrewApi<{ mounted: string[]; skipped: SkippedRoute[] }>('health'),
    ]).then(([settingsResult, healthResult]) => {
      if (!settingsResult.ok || settingsResult.value === undefined) {
        setLoadError(settingsResult.error?.message ?? 'failed to load configuration')
        return
      }
      setDraft(cloneConfig(settingsResult.value.config))
      setRevision(settingsResult.value.revision)
      if (healthResult.ok && healthResult.value !== undefined) {
        setMounted(healthResult.value.mounted)
        setSkipped(healthResult.value.skipped)
      }
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
      config: draft,
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
