/**
 * dsh-search-plus — a `grep` that accepts the flags real searching needs.
 *
 * The shipped tool exposes `pattern` / `path` / `include` only. Every search that
 * wanted surrounding lines, an inverted match, a file list, a language filter, or
 * two directories at once had to drop into `bash rg … | head`, which is why bash
 * carried most of the searching. This registers a **same-named** tool in each
 * agent's own scope; scoped tools shadow globals, so the model keeps calling
 * `grep` and simply gains parameters.
 *
 * Compatibility work this plugin does on purpose:
 *
 * - **Stock match shape is preserved.** `{ matches: [{ path, lineNumber, line }] }`
 *   stays the contract; context lines ride along with an extra optional
 *   `context: true` field rather than a new shape, so anything reading matches
 *   keeps working.
 * - **The shipped tool stands down by itself.** `dsh-tool-fs-search` guards its
 *   own post-execute with an identity check (`ctx.tools.get(name) !== tool`), so
 *   a shadowed name makes it a no-op. No coordination is needed.
 * - **No harness imports.** The definition is a plain object; the profile cannot
 *   resolve `@deepseek-ai/dsh-tools`, and importing it would risk a second
 *   evaluated copy. Only `ctx.subprocess` and `ctx.workingDirectory` are used.
 *
 * @module dsh-search-plus
 */

import { existsSync, appendFileSync } from 'node:fs'

/** Bundled ripgrep shipped with the desktop app, preferred over PATH. */
const BUNDLED_RG =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'

/** Default caps, overridable through bundle config. */
const DEFAULTS = { maxLines: 400, maxLineBytes: 400 }

/** Timeout must match the stock tool's cooperative budget. */
const TIMEOUT_MS = 30000

/**
 * Locate a ripgrep binary.
 *
 * @returns the bundled binary when present, else `rg` from PATH.
 */
function resolveRg() {
  if (existsSync(BUNDLED_RG)) return BUNDLED_RG
  return 'rg'
}

/**
 * Bound one line preview to a byte budget without splitting a UTF-8 sequence.
 *
 * @param line - the raw line text.
 * @param maxBytes - the budget.
 * @returns the preview, marked when cut.
 */
function previewLine(line, maxBytes) {
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes <= maxBytes) return line
  let cut = Buffer.from(line, 'utf8').subarray(0, maxBytes).toString('utf8')
  // Drop a trailing replacement character produced by cutting mid-sequence.
  cut = cut.replace(/\uFFFD+$/u, '')
  return `${cut} (line truncated)`
}

/**
 * Convert display paths to workdir-relative form when they sit inside it.
 *
 * @param path - a path as ripgrep printed it.
 * @param workdir - the directory the search ran in.
 * @returns the relative path, or the original when outside.
 */
function toRelative(path, workdir) {
  if (!path.startsWith('/')) return path
  if (path === workdir) return '.'
  if (path.startsWith(`${workdir}/`)) return path.slice(workdir.length + 1)
  return path
}

/**
 * Build the ripgrep argument vector for one call.
 *
 * Every model-controlled value is a separate argv element and the target paths
 * ride behind `--`, so a leading-dash value can never be read as a flag.
 *
 * @param args - validated tool arguments.
 * @returns the argv (without the binary).
 */
export function buildArgv(args) {
  const argv = ['--no-config']
  if (args.filesOnly === true) {
    argv.push('--files-with-matches')
  } else {
    argv.push('--json')
  }
  argv.push(`--regexp=${args.pattern}`)
  if (args.caseInsensitive === true) argv.push('--ignore-case')
  if (args.invertMatch === true) argv.push('--invert-match')
  if (typeof args.contextBefore === 'number' && args.contextBefore > 0) argv.push(`--before-context=${args.contextBefore}`)
  if (typeof args.contextAfter === 'number' && args.contextAfter > 0) argv.push(`--after-context=${args.contextAfter}`)
  if (typeof args.context === 'number' && args.context > 0) argv.push(`--context=${args.context}`)
  if (typeof args.type === 'string' && args.type.length > 0) argv.push(`--type=${args.type}`)
  if (typeof args.include === 'string' && args.include.length > 0) argv.push(`--glob=${args.include}`)
  if (typeof args.exclude === 'string' && args.exclude.length > 0) argv.push(`--glob=!${args.exclude}`)
  const paths = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : args.path !== undefined ? [args.path] : []
  if (paths.length > 0) argv.push('--', ...paths)
  return argv
}

/**
 * Parse `rg --json` NDJSON into matches and context lines.
 *
 * @param stdout - complete raw stdout.
 * @returns `{ matches }` in output order.
 */
export function parseJsonMatches(stdout) {
  const matches = []
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue
    let record
    try {
      record = JSON.parse(raw)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'match' && record.type !== 'context') continue
    const data = record.data
    if (data === null || typeof data !== 'object') continue
    const path = typeof data.path === 'object' && data.path !== null ? data.path.text : undefined
    const lineNumber = data.line_number
    const lines = data.lines
    if (typeof path !== 'string' || typeof lineNumber !== 'number') continue
    if (lines === null || typeof lines !== 'object') continue
    const text = typeof lines.text === 'string' ? lines.text.replace(/\r?\n$/, '') : '(line is not valid UTF-8)'
    matches.push(record.type === 'context' ? { path, lineNumber, line: text, context: true } : { path, lineNumber, line: text })
  }
  return { matches }
}

/**
 * Render the result as plain text, mirroring grep's own presentation.
 *
 * @param value - the tool output value.
 * @param options - resolved caps.
 * @returns one text block.
 */
function renderResult(value, options) {
  if (Array.isArray(value.files) && value.files.length > 0) {
    return [{ type: 'text', text: value.files.join('\n') }]
  }
  const matches = Array.isArray(value.matches) ? value.matches : []
  if (matches.length === 0) return [{ type: 'text', text: 'No matches found.' }]
  const lines = []
  let lastPath
  let truncated = 0
  for (let index = 0; index < matches.length; index += 1) {
    if (index >= options.maxLines) {
      truncated = matches.length - options.maxLines
      break
    }
    const match = matches[index]
    if (match.path !== lastPath) {
      if (lastPath !== undefined) lines.push('')
      lines.push(`${match.path}:`)
      lastPath = match.path
    }
    const separator = match.context === true ? '-' : ':'
    lines.push(`  ${match.lineNumber}${separator} ${previewLine(match.line, options.maxLineBytes)}`)
  }
  if (truncated > 0) lines.push(`\n(${truncated} more line(s) not shown; narrow the pattern or path)`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Validate arguments; throws with a message the model can act on.
 *
 * @param args - raw tool arguments.
 * @returns the normalized arguments.
 */
function parseArgs(args) {
  if (typeof args?.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string')
  }
  for (const key of ['contextBefore', 'contextAfter', 'context']) {
    const value = args[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${key} must be a non-negative number when given`)
    }
  }
  const paths = Array.isArray(args.paths) ? args.paths.filter((entry) => typeof entry === 'string' && entry.length > 0) : undefined
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...paths !== undefined && paths.length > 0 ? { paths } : {},
    ...args.include !== undefined ? { include: args.include } : {},
    ...args.exclude !== undefined ? { exclude: args.exclude } : {},
    ...args.type !== undefined ? { type: args.type } : {},
    ...args.caseInsensitive === true ? { caseInsensitive: true } : {},
    ...args.invertMatch === true ? { invertMatch: true } : {},
    ...args.filesOnly === true ? { filesOnly: true } : {},
    ...typeof args.contextBefore === 'number' ? { contextBefore: args.contextBefore } : {},
    ...typeof args.contextAfter === 'number' ? { contextAfter: args.contextAfter } : {},
    ...typeof args.context === 'number' ? { context: args.context } : {},
  }
}

/**
 * Build the tool definition bound to the plugin's own context.
 *
 * `exec` carries no `ctx` (it exposes token/callId/name/signal/agent/arguments
 * only), so the subprocess and working-directory services must come from the
 * plugin context captured here.
 *
 * @param service - resolves a service by name at call time, so the tool works
 *   regardless of bundle load order.
 * @returns the tool definition as plain data (no harness import).
 */
function makeTool(service) {
  return {
  name: 'grep',
  description:
    'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file, and can include surrounding context lines. Use this instead of shell grep/rg: it needs no piping, no `| head`, and no second call to see context. Supports several paths in one call, an inverted match, a files-only list, a case-insensitive match and a language type filter.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Several files or directories to search in one call. Prefer this over one call per path; takes precedence over `path`.',
      },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Negation is not supported here — use `exclude`.' },
      exclude: { type: 'string', description: 'One glob to exclude, e.g. "**/worktrees/**" or "*.min.js".' },
      type: { type: 'string', description: 'Ripgrep language type filter, e.g. "go", "ts", "md". Cheaper and more precise than a glob.' },
      contextBefore: { type: 'number', description: 'Lines of context to show before each match (ripgrep -B).' },
      contextAfter: { type: 'number', description: 'Lines of context to show after each match (ripgrep -A).' },
      context: { type: 'number', description: 'Lines of context on both sides of each match (ripgrep -C).' },
      invertMatch: { type: 'boolean', description: 'Return lines that do NOT match (ripgrep -v).' },
      filesOnly: { type: 'boolean', description: 'Return only the paths of files containing a match (ripgrep -l), without line content.' },
      caseInsensitive: { type: 'boolean', description: 'Match case-insensitively (ripgrep -i).' },
    },
  },
  timeoutMs: TIMEOUT_MS,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matches: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              lineNumber: { type: 'integer' },
              line: { type: 'string' },
              context: { type: 'boolean' },
            },
            required: ['path', 'lineNumber', 'line'],
          },
        },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['matches'],
    },
    render: (args, value) => renderResult(value, { maxLines: DEFAULTS.maxLines, maxLineBytes: DEFAULTS.maxLineBytes }),
  },
  async execute(args, exec) {
    const input = parseArgs(args)
    const subprocess = service('subprocess')
    const workingDirectory = service('workingDirectory')
    if (subprocess === undefined) throw new Error('grep: subprocess service is unavailable')
    const workdir =
      exec.agent === undefined || exec.agent === null || workingDirectory === undefined
        ? process.cwd()
        : await workingDirectory.ensure(exec.agent, exec.signal)
    const argv = [resolveRg(), ...buildArgv(input)]
    const handle = subprocess.spawn({
      argv,
      cwd: workdir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 8192 } },
      graceMs: 1500,
      signal: exec.signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    if (outcome.signal !== null || outcome.exitCode === null) {
      throw new Error(`grep was killed by signal ${outcome.signal ?? '(unknown)'}`)
    }
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      throw new Error(`grep failed (exit ${outcome.exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`)
    }
    if (outcome.exitCode === 1) return { matches: [] }
    if (input.filesOnly === true) {
      const files = stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => toRelative(line, workdir))
      return { matches: [], files }
    }
    const parsed = parseJsonMatches(stdout)
    return { matches: parsed.matches.map((match) => ({ ...match, path: toRelative(match.path, workdir) })) }
  },
  }
}

/**
 * Install the shadowed tool per agent.
 *
 * @param ctx - plugin context; registrations are scoped to it.
 * @param config - validated bundle config.
 */
/**
 * Append one line to the shared boot log.
 *
 * Plugin load failures are swallowed by the harness, so without a marker there is
 * no way to tell "the bundle never loaded" from "apply ran but did nothing".
 * This writes only at load/apply time, never per tool call.
 *
 * @param plugin - plugin name for the log line.
 * @param stage - what just happened.
 * @param detail - optional extra context.
 */
function bootMark(plugin, stage, detail) {
  try {
    const line = `${new Date().toISOString()} ${plugin} ${stage}${detail === undefined ? '' : ` ${detail}`}\n`
    appendFileSync(`${process.env.HOME}/.dsh/plugin-boot.log`, line)
  } catch {
    // Diagnostics must never break loading.
  }
}

/**
 * Declared service dependencies.
 *
 * Without this, cordis does not wait for the services before running `apply`,
 * so `ctx.get(name)` returns undefined at apply time and the plugin silently
 * does nothing. The fiber stays inactive until every name here is available.
 */
export const inject = ['tools', 'subprocess', 'workingDirectory']

export function apply(ctx, config = {}) {
  bootMark('dsh-search-plus', 'APPLY-ENTER')
  if (config.enabled === false) return
  Object.assign(DEFAULTS, {
    ...(typeof config.maxLines === 'number' ? { maxLines: config.maxLines } : {}),
    ...(typeof config.maxLineBytes === 'number' ? { maxLineBytes: config.maxLineBytes } : {}),
  })

  // `inject` above guarantees these are ready, so resolving here is safe. The
  // tool body resolves them again per call, which keeps it correct even if a
  // provider is swapped at runtime.
  // With `inject` declared, cordis exposes each service as a property AND via
  // `ctx.get`; read the property first and keep `get` as a fallback.
  const service = (name) => ctx[name] ?? (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

  const tools = service('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    bootMark('dsh-search-plus', 'ABORT', 'tools service unavailable')
    return
  }
  const tool = makeTool(service)

  /** Disposers kept in the plugin's own effect too, so unload removes them. */
  const disposers = new Map()

  // `global: true` is required: `agent/created` is emitted on the agent's own
  // carrier context, and a non-global listener is filtered out before it runs.
  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent.ctx === undefined) return
    try {
      const dispose = agent.ctx.effect(() => agent.ctx.tools.register(tool))
      disposers.set(agent.id, dispose)
      bootMark('dsh-search-plus', 'SHADOWED', agent.id)
    } catch (error) {
      // A shadowing failure must leave the shipped grep in place, not break the agent.
      bootMark('dsh-search-plus', 'SHADOW-ERROR', String(error).slice(0, 200))
    }
  }, { global: true })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    const dispose = disposers.get(agent.id)
    if (dispose === undefined) return
    disposers.delete(agent.id)
    try {
      dispose()
    } catch {
      // Already torn down with the agent context.
    }
  }, { global: true })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers.values()) {
        try {
          dispose()
        } catch {
          // Best effort.
        }
      }
      disposers.clear()
    })
  }
  bootMark('dsh-search-plus', 'LISTENER-INSTALLED')
}

// Reached only when the bundle module is imported by the loader.
bootMark('dsh-search-plus', 'MODULE-LOADED')

