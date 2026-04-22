import consola from "consola"
import fs from "node:fs"

import { PATHS } from "./paths"

export interface AccountConfig {
  id: string
  login: string
  avatarUrl: string
  token: string
  accountType: "individual" | "business" | "enterprise"
  createdAt: string
}

export interface AppConfig {
  extraPrompts?: Record<string, string>
  smallModel?: string
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
  modelMapping?: Record<string, string>
  /**
   * Force specific models for subagent requests based on their `agent_type`
   * (provided via the `__SUBAGENT_MARKER__` plugin hook).
   *
   * Only requests whose marker is parsed by the `/v1/messages` handler will be
   * matched. Main-conversation requests (no marker) are never affected.
   *
   * Keys are case-sensitive agent_type strings (e.g. "Explore",
   * "statusline-setup"). Values are the target model id — they go through
   * `modelMapping` afterwards, so you can write either a Copilot model id
   * directly (e.g. "gpt-5-mini") or an alias ("haiku") that resolves via
   * `modelMapping`.
   */
  subagentModelOverrides?: Record<string, string>
  useFunctionApplyPatch?: boolean
  rateLimitSeconds?: number
  rateLimitWait?: boolean
  // Account management
  accounts?: Array<AccountConfig>
  activeAccountId?: string | null
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const defaultConfig: AppConfig = {
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.1-codex-max": gpt5ExplorationPrompt,
  },
  smallModel: "gpt-5-mini",
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
  },
  modelMapping: {
    // Claude model aliases -> Copilot models
    haiku: "gpt-5-mini",
    "claude-haiku-3-5": "gpt-5-mini",
    "claude-3-5-haiku": "gpt-5-mini",
    "claude-3-5-haiku-20241022": "gpt-5-mini",
  },
  subagentModelOverrides: {
    // High-volume, low-reasoning subagent workflows (grep + read loops,
    // maintenance scripts) — force cheap model to avoid burning premium.
    // Delete an entry in admin UI / config.json to restore the original model.
    Explore: "gpt-5-mini",
    "statusline-setup": "gpt-5-mini",
    "output-style-setup": "gpt-5-mini",
  },
  useFunctionApplyPatch: true,
  rateLimitWait: false,
  accounts: [],
  activeAccountId: null,
}

let cachedConfig: AppConfig | null = null

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      return
    }
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return defaultConfig
  }
}

function mergeDefaultExtraPrompts(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  if (missingExtraPromptModels.length === 0) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
    },
    changed: true,
  }
}

/**
 * Seed `subagentModelOverrides` when the field is missing from config.json
 * (first run / older install). If the user explicitly sets it to `{}` we
 * respect that and do NOT re-seed — they opted out.
 */
function mergeDefaultSubagentOverrides(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  if (config.subagentModelOverrides !== undefined) {
    return { mergedConfig: config, changed: false }
  }
  return {
    mergedConfig: {
      ...config,
      subagentModelOverrides: defaultConfig.subagentModelOverrides,
    },
    changed: true,
  }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()
  const extraPromptsResult = mergeDefaultExtraPrompts(config)
  const overridesResult = mergeDefaultSubagentOverrides(
    extraPromptsResult.mergedConfig,
  )
  const finalConfig = overridesResult.mergedConfig
  const changed = extraPromptsResult.changed || overridesResult.changed

  if (changed) {
    try {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(finalConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn("Failed to write merged defaults to config file", writeError)
    }
  }

  cachedConfig = finalConfig
  return finalConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= readConfigFromDisk()
  return cachedConfig
}

/**
 * Save config to disk (async)
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  ensureConfigFile()
  cachedConfig = config
  const content = `${JSON.stringify(config, null, 2)}\n`
  await fs.promises.writeFile(PATHS.CONFIG_PATH, content, "utf8")
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  return config.extraPrompts?.[model] ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  return config.smallModel ?? "gpt-5-mini"
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const config = getConfig()
  const configuredEffort = config.modelReasoningEfforts?.[model]

  if (configuredEffort) {
    return configuredEffort
  }

  if (model.startsWith("gpt-5.2")) {
    return "xhigh"
  }

  if (model.startsWith("gpt-5.1")) {
    return "xhigh"
  }

  return "high"
}

export function getMappedModel(model: string): string {
  const config = getConfig()
  return config.modelMapping?.[model] ?? model
}

/**
 * Returns the configured override target model for a given subagent
 * `agent_type`, or `null` if no override is configured.
 *
 * Matching is exact and case-sensitive against the `agent_type` field from
 * the `__SUBAGENT_MARKER__` injected by the `copilot-api-subagent-marker`
 * plugin hook.
 */
export function getSubagentModelOverride(
  agentType: string | null | undefined,
): string | null {
  if (!agentType) return null
  const config = getConfig()
  return config.subagentModelOverrides?.[agentType] ?? null
}

/**
 * Resolve "auto" to a concrete model when the upstream doesn't have a model
 * literally named "auto". Strategy:
 * 1. Find a model whose id contains "auto" (e.g. "goldeneye-free-auto") — these
 *    are typically quota-free routing models provided by the account.
 * 2. Fall back to the configured smallModel.
 */
export function resolveAutoModel(
  models?: Array<{ id: string; model_picker_enabled: boolean }>,
): string {
  const autoLike = models?.find((m) => m.id !== "auto" && m.id.includes("auto"))
  if (autoLike) return autoLike.id
  return getSmallModel()
}
