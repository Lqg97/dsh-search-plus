/**
 * Smoke test for dsh-search-plus.
 *
 * Two layers:
 *  1. Pure functions (argv building, NDJSON parsing, arg validation) — no I/O.
 *  2. Real ripgrep, driven through the tool's own `execute` against a fake exec
 *     context, so the whole path (argv → subprocess → parse → shape) is covered.
 *
 * Usage: node test/smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { apply, buildArgv, parseJsonMatches } from '../index.js'

/**
 * The repo itself is the search root: every end-to-end case below searches
 * files checked into `test/fixtures`, so a fresh clone runs the same suite with
 * no sibling repositories and no path outside this checkout.
 */
const WORKDIR = fileURLToPath(new URL('..', import.meta.url))
const SAMPLE = 'test/fixtures/src/parser/sample.go'

/** `rg` on PATH is required for the end-to-end cases; the pure cases run without it. */
const RG_AVAILABLE = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`)
    failures += 1
  }
}

/** Fake exec exposing the two services the tool body uses. */
function fakeExec(workdir) {
  return {
    agent: { id: 'a1' },
    signal: undefined,
    ctx: {
      workingDirectory: { ensure: async () => workdir },
      subprocess: {
        spawn({ argv, cwd }) {
          const child = spawn(argv[0], argv.slice(1), { cwd, stdio: 'pipe' })
          let out = ''
          let err = ''
          child.stdout.on('data', (chunk) => {
            out += chunk
          })
          child.stderr.on('data', (chunk) => {
            err += chunk
          })
          const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ exitCode: code, signal })))
          return {
            done,
            collected: {
              stdout: { readFrom: () => ({ text: out }) },
              stderr: { readFrom: () => ({ text: err }) },
            },
          }
        },
      },
    },
  }
}

/** Reach the registered tool definition by capturing it from a fake agent. */
function captureTool(exec) {
  let captured
  const register = (definition) => ((captured = definition), () => {})
  const services = {
    tools: { register },
    subprocess: exec.ctx.subprocess,
    workingDirectory: exec.ctx.workingDirectory,
  }
  const ctx = {
    tools: services.tools,
    get: (name) => services[name],
    on: (event, handler) => {
      if (event === 'agent/created') {
        handler({ agent: { id: 'a1', ctx: { effect: (fn) => fn(), tools: { register } } } })
      }
    },
    effect: () => {},
  }
  apply(ctx, {})
  return captured
}

console.log('dsh-search-plus smoke test')

// --- argv -----------------------------------------------------------------
check('plain pattern rides in --regexp=', buildArgv({ pattern: 'foo' }).includes('--regexp=foo'))
check('context-after maps to --after-context', buildArgv({ pattern: 'f', contextAfter: 3 }).includes('--after-context=3'))
check('context-before maps to --before-context', buildArgv({ pattern: 'f', contextBefore: 2 }).includes('--before-context=2'))
check('context maps to --context', buildArgv({ pattern: 'f', context: 5 }).includes('--context=5'))
check('invert maps to --invert-match', buildArgv({ pattern: 'f', invertMatch: true }).includes('--invert-match'))
check('filesOnly drops --json', !buildArgv({ pattern: 'f', filesOnly: true }).includes('--json'))
check('type maps to --type=', buildArgv({ pattern: 'f', type: 'go' }).includes('--type=go'))
check('exclude becomes a negated glob', buildArgv({ pattern: 'f', exclude: '**/w/**' }).includes('--glob=!**/w/**'))
check('several paths ride behind --', buildArgv({ pattern: 'f', paths: ['a', 'b'] }).join(' ').endsWith('-- a b'))
check(
  'a dash-leading pattern cannot become a flag',
  buildArgv({ pattern: '--files' }).includes('--regexp=--files') && !buildArgv({ pattern: '--files' }).includes('--files'),
)

// --- parsing --------------------------------------------------------------
{
  const match = JSON.stringify({ type: 'match', data: { path: { text: 'a.go' }, line_number: 3, lines: { text: 'hit\n' } } })
  const context = JSON.stringify({ type: 'context', data: { path: { text: 'a.go' }, line_number: 4, lines: { text: 'near\n' } } })
  const begin = JSON.stringify({ type: 'begin', data: { path: { text: 'a.go' } } })
  const parsed = parseJsonMatches([match, context, begin].join('\n'))
  check('keeps match records', parsed.matches.some((entry) => entry.line === 'hit' && entry.context === undefined))
  check('keeps context records, flagged', parsed.matches.some((entry) => entry.line === 'near' && entry.context === true))
  check('drops non-content records', parsed.matches.length === 2)
  check('tolerates malformed lines', parseJsonMatches('not json\n').matches.length === 0)
}

// --- the registered definition -------------------------------------------
const exec = fakeExec(WORKDIR)
const tool = captureTool(exec)
check('registers a tool named grep', tool?.name === 'grep')
check('declares the stock output shape', tool?.output?.schema?.properties?.matches !== undefined)
check('declares a render function', typeof tool?.output?.render === 'function')
check('exposes context parameters', tool?.parameters?.properties?.contextAfter !== undefined)
check('exposes paths as an array', tool?.parameters?.properties?.paths?.type === 'array')

// --- real ripgrep through the tool body ----------------------------------
// These cases need a working `rg`; the pure cases above do not.
if (!RG_AVAILABLE) {
  console.log('  skip end-to-end cases: no `rg` on PATH')
} else {

{
  const value = await tool.execute({ pattern: 'TestUnit_rootParser', paths: [SAMPLE] }, exec)
  check('real search finds the sample', value.matches.length > 0, `${value.matches.length} matches`)
  check('returns workdir-relative paths', value.matches.every((entry) => !entry.path.startsWith('/')))
}
{
  const value = await tool.execute({ pattern: 'TestUnit_rootParser', paths: [SAMPLE], contextAfter: 2 }, exec)
  check('contextAfter yields context lines', value.matches.some((entry) => entry.context === true))
}
{
  const value = await tool.execute({ pattern: 'FUNC TESTUNIT', paths: [SAMPLE], caseInsensitive: true }, exec)
  check('caseInsensitive matches across case', value.matches.length > 0)
}
{
  const value = await tool.execute({ pattern: 'TestUnit_rootParser', filesOnly: true, type: 'go', paths: ['test/fixtures/src/parser'] }, exec)
  check('filesOnly returns paths', Array.isArray(value.files) && value.files.length > 0)
}
{
  const withTest = await tool.execute({ pattern: 'func ', type: 'go', paths: ['test/fixtures/src/parser'] }, exec)
  const withoutTest = await tool.execute({ pattern: 'func ', type: 'go', exclude: '**/*_test.go', paths: ['test/fixtures/src/parser'] }, exec)
  check('exclude removes files', withoutTest.matches.length < withTest.matches.length)
}
{
  const value = await tool.execute({ pattern: 'zzz_no_such_symbol_zzz', paths: [SAMPLE] }, exec)
  check('a miss yields an empty match list', value.matches.length === 0)
}
{
  let threw = false
  try {
    await tool.execute({ pattern: '' }, exec)
  } catch {
    threw = true
  }
  check('an empty pattern is rejected', threw)
}
}

// --- render ---------------------------------------------------------------
{
  const rendered = tool.output.render({ pattern: 'x' }, { matches: [{ path: 'a.go', lineNumber: 1, line: 'hi' }] })
  check('render produces one text block', Array.isArray(rendered) && rendered[0]?.type === 'text')
  check('render groups by file', rendered[0].text.includes('a.go:'))
}
{
  const rendered = tool.output.render({ pattern: 'x' }, { matches: [] })
  check('render reports a miss', rendered[0].text.includes('No matches'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
