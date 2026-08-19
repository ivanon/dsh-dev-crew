import type { ConfigurableProvider, LiveProvider } from './health.ts'
import type { MountSpec, SkippedRoute } from './mount.ts'
import { diffMounts, planMounts } from './mount.ts'
import type { CrewRole } from './types.ts'

/** 挂载一个委派工具实例，返回卸载它的函数。 */
export interface MountFn {
  (spec: MountSpec): Promise<() => Promise<void>>
}

/** 协调器的外部依赖，全部可注入以便测试。 */
export interface CoordinatorDeps {
  /** 实际执行挂载的函数；生产实现调用 `ctx.plugin()`。 */
  readonly mount: MountFn
  /** 读取当前的 provider 拓扑。 */
  readonly readProviders: () => {
    readonly live: readonly LiveProvider[]
    readonly configurable: readonly ConfigurableProvider[]
  }
  /** 每次同步后报告被跳过的路由。 */
  readonly onSkipped: (skipped: readonly SkippedRoute[]) => void
  /** 报告同步过程中的失败；协调器自身不决定如何呈现。 */
  readonly onError: (error: unknown) => void
}

interface MountedEntry {
  readonly spec: MountSpec
  readonly dispose: () => Promise<void>
}

/**
 * 挂载协调器：把「当前角色配置」同步成「当前已挂载的委派工具集合」。
 *
 * 全部公开方法通过一条 promise 链串行化。两次同步若并发执行，第二次会看不到
 * 第一次的挂载结果，导致同一个工具名被重复挂载 —— 而重复挂载的第二次会失败、
 * 其错误被 fiber 吞掉，同时覆盖第一个实例的卸载句柄，使那个工具再也卸不掉。
 */
export class CrewCoordinator {
  private readonly mounted = new Map<string, MountedEntry>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * 把已挂载集合同步到给定的角色配置。
   * @param roles - 当前配置中的角色列表。
   * @returns 本次同步完成的 promise；永不拒绝，失败通过 `onError` 报告。
   */
  sync(roles: readonly CrewRole[]): Promise<void> {
    this.queue = this.queue.then(() => this.runSync(roles), () => this.runSync(roles))
    return this.queue
  }

  /** 当前已挂载的工具名，按挂载顺序。 */
  mountedToolNames(): readonly string[] {
    return [...this.mounted.keys()]
  }

  /** 卸载全部已挂载的工具。 */
  dispose(): Promise<void> {
    this.queue = this.queue.then(() => this.runSync([]), () => this.runSync([]))
    return this.queue
  }

  private async runSync(roles: readonly CrewRole[]): Promise<void> {
    try {
      const { live, configurable } = this.deps.readProviders()
      const plan = planMounts(roles, live, configurable)
      const diff = diffMounts([...this.mounted.values()].map(entry => entry.spec), plan.specs)

      for (const toolName of diff.toRemove) {
        const entry = this.mounted.get(toolName)
        if (entry === undefined) continue
        // 先忘记再卸载：卸载失败时状态也不会停在「记着但已半死」。
        this.mounted.delete(toolName)
        try {
          await entry.dispose()
        } catch (error: unknown) {
          this.deps.onError(error)
        }
      }

      for (const spec of diff.toAdd) {
        try {
          const dispose = await this.deps.mount(spec)
          this.mounted.set(spec.toolName, { spec, dispose })
        } catch (error: unknown) {
          this.deps.onError(error)
        }
      }

      this.deps.onSkipped(plan.skipped)
    } catch (error: unknown) {
      // planMounts 对重复工具名 fail loud，落在这里。
      this.deps.onError(error)
    }
  }
}
