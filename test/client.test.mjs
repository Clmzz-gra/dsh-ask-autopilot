// Browser-half checks for dsh-ask-autopilot: the question watcher (sound,
// deadline, and the cards it must leave alone) plus the settings page's data
// mapping against the Host schema.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { Config } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

/** Let pending promise chains settle. */
async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

/** Load the browser bundle in a fake page and record what it does. */
function browser() {
  const state = {
    loaded: null,
    oscillators: 0,
    fetches: [],
    config: {
      enabled: true,
      timeoutMinutes: 0.1,
      strategy: 'recommended',
      optionless: 'custom',
      customText: 'continue',
      skipPlanReview: true,
      sound: { enabled: true, source: 'preset', preset: 'chime', file: '', url: '', volume: 0.6 },
    },
    answer: { answers: [{ id: 'q', selected: ['A (Recommended)'] }] },
  }

  /** One node that satisfies both oscillator and buffer-source calls. */
  const audioNode = () => ({
    gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    frequency: { setValueAtTime() {} },
    buffer: null,
    connect() {},
    start() { state.oscillators += 1 },
    stop() {},
  })
  /** One gain node, used for both the shared output and per-tone envelopes. */
  const gainNode = () => ({
    gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect() {},
  })

  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
    }
    createGain() {
      return gainNode()
    }
    createOscillator() {
      return audioNode()
    }
    createBufferSource() {
      return audioNode()
    }
    decodeAudioData() {
      return Promise.resolve({})
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
  }

  const sandbox = {
    window: {
      AudioContext: FakeAudioContext,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load({ factory }) {
          state.loaded = { exports: factory(requireStub) }
        },
      },
    },
    document: { addEventListener() {}, removeEventListener() {} },
    // Hooks delegate to the renderer a page test installs; see `activeHooks`.
    React: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: (initial) => activeHooks.useState(initial),
      useEffect: (effect, deps) => activeHooks.useEffect(effect, deps),
    },
    fetch: async (url) => {
      state.fetches.push({ url })
      if (url === '/ask-autopilot/config') return { ok: true, status: 200, json: async () => state.config }
      if (url === '/ask-autopilot/auto-answer') return { ok: true, status: 200, json: async () => ({ answer: state.answer }) }
      return { ok: false, status: 404, json: async () => ({}) }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // The bundle runs in this realm's Date so `mock.timers` can advance it.
    Date,
    console,
  }
  /** The client bundle requires React from the host module table and nothing else. */
  function requireStub(specifier) {
    if (specifier === 'react') return sandbox.React
    throw new Error(`unexpected require ${specifier}`)
  }

  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  return { state, exports: state.loaded.exports }
}

/** A pending question card with the shape the question UI publishes. */
function card(overrides = {}) {
  const answers = []
  const interaction = {
    kind: 'question',
    key: 'question:session:call-1',
    questions: [{ id: 'q', question: '?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }],
    answer: async (value) => {
      answers.push(value)
    },
    getSnapshot: () => ({
      state: 'open', waitState: 'counting', channel: 'waterfall', closed: false,
      countdown: { remainingMs: 1000, running: true },
    }),
    ...overrides,
  }
  return { interaction, answers }
}

/** A client context whose services record registrations and own their disposers. */
function clientContext() {
  const registrations = []
  const injected = []
  const remoteHandlers = new Map()
  const disposers = []
  /** Dictionaries the plugin registered, so a rendered page resolves real copy. */
  const dictionaries = new Map()
  /** Run every recorded disposer, newest first, so no interval outlives a test. */
  const disposeAll = () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // A disposer that already ran is not a test failure.
      }
    }
    disposers.length = 0
  }
  const keep = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  const ctx = {
    get: () => undefined,
    effect: (factory, label) => {
      registrations.push(label)
      keep(factory())
      return () => {}
    },
    on: () => () => {},
    locale: {
      register: (ns, locale, dict) => {
        dictionaries.set(`${ns}:${locale}`, dict)
        return () => {}
      },
      bind: (ns) => (key) => dictionaries.get(`${ns}:zh`)?.[key] ?? key,
      subscribe: () => () => {},
      getSnapshot: () => ({ id: 'zh' }),
    },
    remote: {
      $on: (name, handler) => {
        remoteHandlers.set(name, handler)
        return () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ slot: options.name, options, component })
        return () => {}
      },
    },
    inject: (services, callback) => {
      injected.push(services)
      if (!services.includes('uiSession')) return
      callback({
        effect: (factory) => {
          keep(factory())
          return () => {}
        },
        uiSession: ctx.__uiSession,
      })
    },
  }
  return { ctx, registrations, injected, remoteHandlers, disposeAll }
}

/** Install a Session status source the test can change. */
function sessionStatus(ctx) {
  let snapshot = new Map()
  const listeners = new Set()
  ctx.__uiSession = {
    sessionStatus: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  return {
    set(interactions) {
      snapshot = new Map(interactions.map((interaction, index) => [`s${String(index)}`, { pendingInteraction: interaction }]))
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Load the bundle, apply it to a fake client, run the body, then dispose.
 * @param run - the test body, given the fake page, the plugin exports, the
 *   registrations, and the mutable Session status source.
 * @returns settlement of the body after disposal.
 */
async function withPlugin(run) {
  const { state, exports } = browser()
  const harness = clientContext()
  const status = sessionStatus(harness.ctx)
  exports.apply(harness.ctx)
  await flush()
  try {
    await run({ state, exports, harness, status })
  } finally {
    harness.disposeAll()
  }
}

/**
 * Run one body under fake timers.
 * @param run - the test body.
 * @returns settlement after the timers are reset.
 */
async function withFakeTimers(run) {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    await run()
  } finally {
    mock.timers.reset()
  }
}

test('the bundle registers itself under its package name', async () => {
  const { state } = browser()
  assert.ok(state.loaded !== null)
  assert.equal(typeof state.loaded.exports.apply, 'function')
})

test('apply registers dictionaries, audio unlock, settings invalidation, and the section', async () => {
  await withPlugin(async ({ harness }) => {
    assert.ok(harness.registrations.includes('ask-autopilot: dictionaries'))
    assert.ok(harness.registrations.includes('ask-autopilot: audio unlock'))
    assert.ok(harness.injected.some(services => services.includes('uiSession')))
    assert.ok(harness.remoteHandlers.has('settings/document-updated'))
    const section = harness.registrations.find(entry => entry.slot === 'settings.section')
    assert.ok(section !== undefined)
    assert.equal(section.options.id, 'ask-autopilot')
  })
})

test('a question is auto-answered once the deadline passes', async () => {
  await withFakeTimers(() => withPlugin(async ({ state, status }) => {
    status.set([])
    const question = card()
    status.set([question.interaction])
    await flush()

    // The configured wait in this fixture is 0.1 minutes: six seconds.
    mock.timers.tick(5000)
    await flush()
    assert.equal(question.answers.length, 0, 'nothing is answered before the deadline')

    mock.timers.tick(5000)
    await flush()
    assert.equal(question.answers.length, 1)
    assert.deepEqual(question.answers[0], state.answer)
    assert.ok(state.fetches.some(entry => entry.url === '/ask-autopilot/auto-answer'))
  }))
})

test('a new question plays the configured sound', async () => {
  await withFakeTimers(() => withPlugin(async ({ state, status }) => {
    status.set([])
    await flush()
    assert.equal(state.oscillators, 0)

    const question = card()
    status.set([question.interaction])
    await flush()
    assert.ok(state.oscillators > 0, 'a newly appeared question sounds')
  }))
})

test('a review card neither sounds nor answers', async () => {
  await withFakeTimers(() => withPlugin(async ({ state, status }) => {
    status.set([])
    const review = card({ review: { questions: [], answers: [] } })
    status.set([review.interaction])
    await flush()
    mock.timers.tick(60_000)
    await flush()

    assert.equal(state.oscillators, 0)
    assert.equal(review.answers.length, 0)
  }))
})

test('a continued question is left alone', async () => {
  await withFakeTimers(() => withPlugin(async ({ status }) => {
    status.set([])
    const continued = card({
      getSnapshot: () => ({
        state: 'continued', waitState: 'continued', channel: 'rpc', closed: false, countdown: undefined,
      }),
    })
    status.set([continued.interaction])
    await flush()
    mock.timers.tick(60_000)
    await flush()
    assert.equal(continued.answers.length, 0)
  }))
})

test('a focused or editing card restarts its count', async () => {
  await withFakeTimers(() => withPlugin(async ({ status }) => {
    status.set([])
    let waitState = 'counting'
    const question = card({
      getSnapshot: () => ({
        state: 'open', waitState, channel: 'waterfall', closed: false,
        countdown: { remainingMs: 1000, running: true },
      }),
    })
    status.set([question.interaction])
    await flush()
    mock.timers.tick(5000)

    // The user starts typing just before the deadline: the count restarts.
    waitState = 'editing'
    status.set([question.interaction])
    mock.timers.tick(5000)
    assert.equal(question.answers.length, 0, 'typing postpones the automatic answer')

    waitState = 'counting'
    mock.timers.tick(10_000)
    await flush()
    assert.equal(question.answers.length, 1)
  }))
})

test('a card without a live waterfall channel is not answered yet', async () => {
  await withFakeTimers(() => withPlugin(async ({ status }) => {
    status.set([])
    const question = card({
      getSnapshot: () => ({
        state: 'open', waitState: 'counting', channel: 'none', closed: false, countdown: undefined,
      }),
    })
    status.set([question.interaction])
    await flush()
    mock.timers.tick(60_000)
    await flush()
    assert.equal(question.answers.length, 0)
  }))
})

test('a refused automatic answer is not retried or sounded again', async () => {
  await withFakeTimers(() => withPlugin(async ({ state, status }) => {
    state.answer = null
    status.set([])
    const question = card()
    status.set([question.interaction])
    await flush()
    const sounding = state.oscillators

    mock.timers.tick(10_000)
    await flush()
    assert.equal(question.answers.length, 0)
    mock.timers.tick(60_000)
    await flush()
    assert.equal(state.oscillators, sounding, 'no second sound for the same card')
  }))
})

test('the settings page maps drafts onto paths the Host schema declares', async () => {
  const { exports } = browser()
  const { draftFrom, draftOps } = exports.internals
  const draft = draftFrom({
    enabled: true,
    timeoutMinutes: 3,
    strategy: 'first',
    optionless: 'skip',
    customText: 'x',
    skipPlanReview: false,
    sound: { enabled: false, source: 'file', preset: 'ding', file: '/a.mp3', url: '', volume: 0.4 },
  })
  const ops = draftOps(draft, 3)
  assert.equal(ops.length, 12)

  const schema = Config
  for (const op of ops) {
    let node = schema
    for (const key of op.path) {
      assert.ok(node.dict !== undefined && node.dict[key] !== undefined,
        `path ${op.path.join('.')} must exist in the Host schema`)
      node = node.dict[key]
    }
  }
  assert.equal(ops.find(op => op.path.join('.') === 'timeoutMinutes').value, 3)
  assert.equal(ops.find(op => op.path.join('.') === 'sound.preset').value, 'ding')
})

test('a saved value round-trips through the page draft', async () => {
  const { exports } = browser()
  const draft = exports.internals.draftFrom({
    enabled: false,
    timeoutMinutes: 12,
    strategy: 'skip',
    optionless: 'custom',
    customText: '按你的判断继续',
    skipPlanReview: true,
    sound: { enabled: true, source: 'url', preset: 'alert', file: '', url: 'https://x/y.mp3', volume: 0.25 },
  })
  assert.equal(draft.enabled, false)
  assert.equal(draft.timeoutMinutes, '12')
  assert.equal(draft.strategy, 'skip')
  assert.equal(draft.customText, '按你的判断继续')
  assert.equal(draft.sound.source, 'url')
  assert.equal(draft.sound.url, 'https://x/y.mp3')
  assert.equal(draft.sound.volume, 0.25)
})

test('an unreadable Host payload falls back to the documented defaults', async () => {
  const { exports } = browser()
  const settings = exports.internals.normalizeConfig(null)
  assert.equal(settings.enabled, true)
  assert.equal(settings.timeoutMinutes, 5)
  assert.equal(settings.strategy, 'recommended')
  assert.equal(settings.sound.preset, 'chime')
  assert.equal(exports.internals.clampMinutes(0), 0.1)
  assert.equal(exports.internals.clampMinutes(1e6), 1440)
})

/**
 * The hook slot list a render pass fills. `browser()` hands the bundle these
 * two calls; a page render swaps in its own implementation, so a component's
 * state survives a re-render the way React keeps it.
 */
let activeHooks = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/**
 * Render a component tree with hook state and re-render, without React.
 *
 * Only what the settings page uses is implemented: `useState` and `useEffect`
 * over one ordered hook list per component, matching React's call-order model.
 *
 * @param component - the root component.
 * @param props - root props.
 * @returns the rendered tree plus the actions a test drives it with.
 */
function mountPage(component, props) {
  const slots = new Map()
  let cursor = null
  let index = 0
  let pendingEffects = []
  let tree = null
  let scheduled = false

  const rerender = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      pass()
    })
  }

  const hooks = {
    useState(initial) {
      const list = slots.get(cursor) ?? []
      const at = index++
      if (!(at in list)) list[at] = typeof initial === 'function' ? initial() : initial
      slots.set(cursor, list)
      const set = (next) => {
        const value = typeof next === 'function' ? next(list[at]) : next
        if (Object.is(value, list[at])) return
        list[at] = value
        rerender()
      }
      return [list[at], set]
    },
    useEffect(effect, deps) {
      const list = slots.get(cursor) ?? []
      const at = index++
      const previous = list[at]
      const changed = previous === undefined
        || deps === undefined
        || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      if (!changed) return
      list[at] = { deps }
      slots.set(cursor, list)
      pendingEffects.push(effect)
    },
  }

  const render = (node) => {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render)
    if (typeof node.type === 'function') {
      const previousComponent = cursor
      const previousIndex = index
      cursor = node.type
      index = 0
      const rendered = node.type({ ...node.props, children: node.children })
      cursor = previousComponent
      index = previousIndex
      return render(rendered)
    }
    return { type: node.type, props: node.props ?? {}, children: render(node.children) }
  }

  const pass = () => {
    pendingEffects = []
    const previous = activeHooks
    activeHooks = hooks
    try {
      tree = render(component(props))
    } finally {
      activeHooks = previous
    }
    const queued = pendingEffects
    pendingEffects = []
    for (const effect of queued) effect()
  }

  pass()
  return {
    /** The current rendered tree. */
    get tree() { return tree },
    /** Let queued state updates and effects settle. */
    async settle() {
      for (let round = 0; round < 4; round += 1) await flush()
    },
  }
}

/**
 * Collect the text of a rendered tree.
 * @param node - rendered tree.
 * @returns every text fragment in render order.
 */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children)
}

/**
 * Find every host element matching a predicate.
 * @param node - rendered tree.
 * @param predicate - test applied to each element's tag name.
 * @returns matching elements in render order.
 */
function findAll(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate))
  const here = predicate(node.type) ? [node] : []
  return here.concat(findAll(node.children, predicate))
}

/** A fake configuration form over one mutable section. */
function fakeForm(section) {
  const writes = []
  return {
    writes,
    form: {
      getSnapshot: () => ({ status: 'ready', value: section, revision: 7, writable: true, base: {}, user: {} }),
      subscribe: () => () => {},
      mutate: async (ops, revision) => {
        writes.push({ ops, revision })
        return true
      },
    },
  }
}

/**
 * Mount the registered settings section with a working form.
 * @param page - the browser harness that loaded the bundle.
 * @param section - the resolved settings section the form reports.
 * @returns the mounted page, the recorded writes, and the harness.
 */
function renderSettings(page, section) {
  const harness = clientContext()
  sessionStatus(harness.ctx)
  const { form, writes } = fakeForm(section)
  harness.ctx.get = (name) => (name === 'configForms' ? { get: () => form } : undefined)
  page.exports.apply(harness.ctx)
  const entry = harness.registrations.find(item => item.slot === 'settings.section')
  const mounted = mountPage(entry.component, { ctx: harness.ctx })
  return { mounted, writes, harness }
}

/** The settings a page test starts from. */
const PAGE_SETTINGS = {
  enabled: true,
  timeoutMinutes: 3,
  strategy: 'recommended',
  optionless: 'custom',
  customText: '继续',
  skipPlanReview: true,
  sound: { enabled: true, source: 'preset', preset: 'chime', file: '', url: '', volume: 0.6 },
}

/** Find one button by its visible label. */
function button(mounted, label) {
  return findAll(mounted.tree, type => type === 'button').find(item => texts(item).includes(label))
}

test('the settings page renders its controls with the resolved values', async () => {
  const page = browser()
  const { mounted, harness } = renderSettings(page, { ...PAGE_SETTINGS, sound: { ...PAGE_SETTINGS.sound, preset: 'marimba', volume: 0.4 } })
  const shown = texts(mounted.tree).join(' | ')
  assert.match(shown, /提问自动驾驶/)
  assert.match(shown, /自动作答/)
  assert.match(shown, /提示音/)
  assert.match(shown, /木琴/)
  assert.match(shown, /继续/)

  const numbers = findAll(mounted.tree, type => type === 'input').filter(input => input.props.type === 'number')
  assert.equal(numbers.length, 1)
  assert.equal(numbers[0].props.value, '3')
  const ranges = findAll(mounted.tree, type => type === 'input').filter(input => input.props.type === 'range')
  assert.equal(ranges[0].props.value, '0.4')
  harness.disposeAll()
})

test('saving writes every field with the form revision', async () => {
  const page = browser()
  const { mounted, writes, harness } = renderSettings(page, PAGE_SETTINGS)
  button(mounted, '保存').props.onClick()
  await mounted.settle()

  assert.equal(writes.length, 1)
  assert.equal(writes[0].revision, 7)
  assert.equal(writes[0].ops.length, 12)
  assert.equal(writes[0].ops.find(op => op.path.join('.') === 'timeoutMinutes').value, 3)
  harness.disposeAll()
})

test('an out-of-range deadline is refused before any write', async () => {
  const page = browser()
  const { mounted, writes, harness } = renderSettings(page, PAGE_SETTINGS)
  const numbers = findAll(mounted.tree, type => type === 'input').filter(input => input.props.type === 'number')
  numbers[0].props.onChange({ target: { value: '9999' } })
  await mounted.settle()
  button(mounted, '保存').props.onClick()
  await mounted.settle()

  assert.equal(writes.length, 0)
  assert.match(texts(mounted.tree).join(' | '), /0\.1 到 1440/)
  harness.disposeAll()
})

test('changing the deadline reaches the saved value', async () => {
  const page = browser()
  const { mounted, writes, harness } = renderSettings(page, PAGE_SETTINGS)
  const numbers = findAll(mounted.tree, type => type === 'input').filter(input => input.props.type === 'number')
  numbers[0].props.onChange({ target: { value: '12' } })
  await mounted.settle()
  button(mounted, '保存').props.onClick()
  await mounted.settle()

  assert.equal(writes.length, 1)
  assert.equal(writes[0].ops.find(op => op.path.join('.') === 'timeoutMinutes').value, 12)
  harness.disposeAll()
})

test('switching the sound source swaps the field it asks for', async () => {
  const page = browser()
  const { mounted, harness } = renderSettings(page, PAGE_SETTINGS)
  const fileField = () => findAll(mounted.tree, type => type === 'input')
    .filter(input => input.props.placeholder === 'D:/sounds/ding.mp3')
  assert.equal(fileField().length, 0)

  const source = findAll(mounted.tree, type => type === 'select').find(select => select.props.value === 'preset')
  source.props.onChange({ target: { value: 'file' } })
  await mounted.settle()
  assert.equal(fileField().length, 1)
  harness.disposeAll()
})

test('the preview action plays the configured preset', async () => {
  const page = browser()
  const { mounted, harness } = renderSettings(page, { ...PAGE_SETTINGS, sound: { ...PAGE_SETTINGS.sound, preset: 'ding' } })
  button(mounted, '试听').props.onClick()
  await mounted.settle()
  assert.ok(page.state.oscillators > 0, 'preview plays a tone')
  harness.disposeAll()
})

test('the page explains itself when no configuration form is served', async () => {
  const page = browser()
  const harness = clientContext()
  sessionStatus(harness.ctx)
  harness.ctx.get = () => undefined
  page.exports.apply(harness.ctx)
  const entry = harness.registrations.find(item => item.slot === 'settings.section')
  const mounted = mountPage(entry.component, { ctx: harness.ctx })
  const shown = texts(mounted.tree).join(' | ')
  harness.disposeAll()
  assert.match(shown, /当前部署未提供该设置表单/)
})
