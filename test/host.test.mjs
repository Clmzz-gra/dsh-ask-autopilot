// Host-half checks for dsh-ask-autopilot: answer policy, settings resolution,
// and the three Web routes, exercised through the real module exports.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply, autoAnswer, answerable, readSettings, wireSettings, parseQuestions, Config,
} from '../index.js'

const BASE = {
  enabled: true,
  timeoutMinutes: 5,
  strategy: 'recommended',
  optionless: 'custom',
  customText: '按你的最佳判断继续（用户超时未回复）',
  skipPlanReview: true,
  sound: { enabled: true, source: 'preset', preset: 'chime', file: '', url: '', volume: 0.6 },
}

const options = (...labels) => labels.map(label => ({ label }))

/** Stand-in for a live calling agent; the listener only needs it to be present. */
const AGENT = { id: 'session-1' }

test('the schema accepts its own defaults', () => {
  const resolved = readSettings(Config(BASE))
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.timeoutMs, 300_000)
  assert.equal(resolved.strategy, 'recommended')
  assert.deepEqual(resolved.sound, BASE.sound)
})

test('recommended suffix wins in either language and either bracket width', () => {
  for (const label of ['A (Recommended)', 'A（推荐）', 'A (推荐)', 'A （recommended）']) {
    const answer = autoAnswer([{ id: 'q', question: '?', options: options('B', label) }], BASE)
    assert.deepEqual(answer.answers, [{ id: 'q', selected: [label] }])
  }
})

test('first option answers when nothing is marked', () => {
  const answer = autoAnswer([{ id: 'q', question: '?', options: options('B', 'C') }], BASE)
  assert.deepEqual(answer.answers, [{ id: 'q', selected: ['B'] }])
})

test('first strategy ignores the marker', () => {
  const settings = { ...BASE, strategy: 'first' }
  const answer = autoAnswer([{ id: 'q', question: '?', options: options('B', 'C (Recommended)') }], settings)
  assert.deepEqual(answer.answers, [{ id: 'q', selected: ['B'] }])
})

test('skip strategy selects nothing even with options', () => {
  const settings = { ...BASE, strategy: 'skip' }
  const answer = autoAnswer([{ id: 'q', question: '?', options: options('B') }], settings)
  assert.deepEqual(answer.answers, [{ id: 'q', selected: [] }])
})

test('an optionless question carries the configured custom text', () => {
  const answer = autoAnswer([{ id: 'q', question: '?' }], BASE)
  assert.deepEqual(answer.answers, [{ id: 'q', selected: [], custom: BASE.customText }])
})

test('an optionless question can be skipped instead', () => {
  const settings = { ...BASE, optionless: 'skip' }
  assert.deepEqual(autoAnswer([{ id: 'q', question: '?' }], settings).answers, [{ id: 'q', selected: [] }])
})

test('a blank custom text falls back to a plain skip', () => {
  const settings = { ...BASE, customText: '   ' }
  assert.deepEqual(autoAnswer([{ id: 'q', question: '?' }], settings).answers, [{ id: 'q', selected: [] }])
})

test('every question of the batch is answered, in order', () => {
  const answer = autoAnswer([
    { id: 'a', question: '?', options: options('X (Recommended)', 'Y') },
    { id: 'b', question: '?' },
  ], BASE)
  assert.deepEqual(answer.answers.map(item => item.id), ['a', 'b'])
  assert.deepEqual(answer.answers[0].selected, ['X (Recommended)'])
})

test('a plan review is left to the user unless the setting allows it', () => {
  const questions = [{ id: 'q', question: '?', options: options('Approve', 'Refuse'), intent: { kind: 'plan-review', approve: 'Approve' } }]
  assert.equal(answerable(questions, BASE), false)
  assert.equal(answerable(questions, { ...BASE, skipPlanReview: false }), true)
  assert.equal(answerable([{ id: 'q', question: '?' }], BASE), true)
  assert.equal(answerable([], BASE), false)
})

test('settings resolve from volatile references and clamp out-of-range values', () => {
  const volatile = value => ({ get: () => value })
  const settings = readSettings({
    enabled: volatile(false),
    timeoutMinutes: volatile(10_000),
    strategy: volatile('nonsense'),
    optionless: volatile('skip'),
    customText: volatile('继续'),
    skipPlanReview: volatile(false),
    sound: {
      enabled: volatile(true),
      source: volatile('url'),
      preset: volatile('nope'),
      file: volatile(''),
      url: volatile('https://example.com/a.mp3'),
      volume: volatile(4),
    },
  })
  assert.equal(settings.enabled, false)
  assert.equal(settings.timeoutMs, 1440 * 60_000)
  assert.equal(settings.strategy, 'recommended')
  assert.equal(settings.optionless, 'skip')
  assert.equal(settings.customText, '继续')
  assert.equal(settings.skipPlanReview, false)
  assert.equal(settings.sound.source, 'url')
  assert.equal(settings.sound.preset, 'chime')
  assert.equal(settings.sound.volume, 1)
})

test('a deadline below the floor is raised to it', () => {
  assert.equal(readSettings({ timeoutMinutes: 0.0001 }).timeoutMs, Math.round(0.1 * 60_000))
})

test('wire settings carry minutes, not milliseconds', () => {
  const wire = wireSettings(readSettings(BASE))
  assert.equal(wire.timeoutMinutes, 5)
  assert.deepEqual(Object.keys(wire).sort(), [
    'customText', 'enabled', 'optionless', 'skipPlanReview', 'sound', 'strategy', 'timeoutMinutes',
  ])
})

test('question parsing rejects malformed payloads', () => {
  assert.equal(parseQuestions(null), undefined)
  assert.equal(parseQuestions({}), undefined)
  assert.equal(parseQuestions({ questions: [] }), undefined)
  assert.equal(parseQuestions({ questions: [{ id: 'a' }] }), undefined)
  assert.equal(parseQuestions({ questions: [{ id: 'a', question: '?', options: [{ description: 'x' }] }] }), undefined)
})

test('question parsing keeps options, multi-select, and the plan-review intent', () => {
  const parsed = parseQuestions({
    questions: [{
      id: 'q',
      question: '?',
      options: [{ label: 'A', description: 'first' }, { label: 'B' }],
      multiSelect: true,
      intent: { kind: 'plan-review', approve: 'A' },
      extra: 'dropped',
    }],
  })
  assert.deepEqual(parsed, [{
    id: 'q',
    question: '?',
    options: [{ label: 'A', description: 'first' }, { label: 'B' }],
    multiSelect: true,
    intent: { kind: 'plan-review', approve: 'A' },
  }])
})

/** Minimal Host context recording listeners and route handlers. */
function fakeHost() {
  const listeners = []
  const routes = new Map()
  const ctx = {
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    inject(services, callback) {
      if (!services.includes('webServer')) return
      callback({
        effect: (factory) => factory(),
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, listeners, routes }
}

/** Call one registered listener with a fake `this` and a stub `next`. */
function dispatch(listener, request, next) {
  return listener.call({}, request, next)
}

test('the answerer is registered as a global prepended listener', () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const registered = listeners.find(entry => entry.event === 'user-questions/request')
  assert.ok(registered !== undefined)
})

test('the listener delegates untouched when disabled', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, { ...BASE, enabled: false })
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  let delegated = false
  const result = await dispatch(listener, { agent: AGENT, questions: [{ id: 'q', question: '?' }] }, async () => {
    delegated = true
    return { answers: [{ id: 'q', selected: ['human'] }] }
  })
  assert.equal(delegated, true)
  assert.deepEqual(result.answers, [{ id: 'q', selected: ['human'] }])
})

test('the human answer wins while the deadline has not passed', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  const result = await dispatch(listener, { agent: AGENT, questions: [{ id: 'q', question: '?', options: options('A (Recommended)') }] },
    async () => ({ answers: [{ id: 'q', selected: ['A (Recommended)'], custom: 'mine' }] }))
  assert.equal(result.answers[0].custom, 'mine')
})

test('a plan review is left to the user', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  let delegated = false
  const pending = dispatch(listener, {
    agent: AGENT,
    questions: [{ id: 'q', question: '?', options: options('Approve'), intent: { kind: 'plan-review', approve: 'Approve' } }],
  }, async () => {
    delegated = true
    return { answers: [{ id: 'q', selected: ['Approve'] }] }
  })
  const result = await pending
  assert.equal(delegated, true)
  assert.deepEqual(result.answers, [{ id: 'q', selected: ['Approve'] }])
})

test('an agentless request has no deadline to run', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  let delegated = false
  const result = await dispatch(listener, { questions: [{ id: 'q', question: '?' }] }, async () => {
    delegated = true
    return { answers: [{ id: 'q', selected: ['programmatic'] }] }
  })
  assert.equal(delegated, true)
  assert.deepEqual(result.answers, [{ id: 'q', selected: ['programmatic'] }])
})

test('a shipped timed wait expiring becomes the automatic answer', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  const timeout = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })
  const result = await dispatch(listener, { agent: AGENT, questions: [{ id: 'q', question: '?', options: options('A (Recommended)') }] },
    async () => { throw timeout })
  assert.deepEqual(result.answers, [{ id: 'q', selected: ['A (Recommended)'] }])
})

test('a downstream failure that is not a timeout propagates', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, BASE)
  const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
  const failure = Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
  await assert.rejects(
    dispatch(listener, { agent: AGENT, questions: [{ id: 'q', question: '?' }] }, async () => { throw failure }),
    /no provider/,
  )
})

test('the Host deadline answers when nobody replies', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { ctx, listeners } = fakeHost()
    apply(ctx, { ...BASE, timeoutMinutes: 0.1 })
    const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
    let settleHuman = () => {}
    const pending = dispatch(listener, {
      agent: AGENT,
      questions: [{ id: 'q', question: '?', options: options('A', 'B (Recommended)') }],
    }, () => new Promise((resolve) => {
      settleHuman = resolve
    }))

    // The configured wait is six seconds; the Host grants itself one more minute.
    mock.timers.tick(60_000)
    mock.timers.tick(7_000)
    const result = await pending
    assert.deepEqual(result.answers, [{ id: 'q', selected: ['B (Recommended)'] }])
    // The downstream answerer must not be left dangling.
    settleHuman({ answers: [{ id: 'q', selected: ['A'] }] })
  } finally {
    mock.timers.reset()
  }
})

test('a human answer arriving first still wins over the Host deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { ctx, listeners } = fakeHost()
    apply(ctx, { ...BASE, timeoutMinutes: 0.1 })
    const { listener } = listeners.find(entry => entry.event === 'user-questions/request')
    const result = await dispatch(listener, {
      agent: AGENT,
      questions: [{ id: 'q', question: '?', options: options('A', 'B (Recommended)') }],
    }, async () => ({ answers: [{ id: 'q', selected: ['A'] }] }))
    assert.deepEqual(result.answers, [{ id: 'q', selected: ['A'] }])
  } finally {
    mock.timers.reset()
  }
})

test('the config route answers the wire settings', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, { ...BASE, timeoutMinutes: 3 })
  const handler = routes.get('/ask-autopilot/config')
  assert.ok(handler !== undefined)
  const response = fakeResponse()
  await handler({ method: 'GET' }, response.res)
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).timeoutMinutes, 3)
})

test('the answer route answers the posted questions', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, BASE)
  const handler = routes.get('/ask-autopilot/auto-answer')
  const response = fakeResponse()
  const body = JSON.stringify({ questions: [{ id: 'q', question: '?', options: options('A', 'B (Recommended)') }] })
  await handler(fakeRequest(body), response.res)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { answer: { answers: [{ id: 'q', selected: ['B (Recommended)'] }] } })
})

test('the answer route refuses a plan review and a disabled plugin', async () => {
  const enabled = fakeHost()
  apply(enabled.ctx, BASE)
  const planReview = fakeResponse()
  await enabled.routes.get('/ask-autopilot/auto-answer')(fakeRequest(JSON.stringify({
    questions: [{ id: 'q', question: '?', options: options('Approve'), intent: { kind: 'plan-review', approve: 'Approve' } }],
  })), planReview.res)
  assert.equal(JSON.parse(planReview.body).answer, null)

  const disabled = fakeHost()
  apply(disabled.ctx, { ...BASE, enabled: false })
  const off = fakeResponse()
  await disabled.routes.get('/ask-autopilot/auto-answer')(fakeRequest(JSON.stringify({
    questions: [{ id: 'q', question: '?', options: options('A') }],
  })), off.res)
  assert.equal(JSON.parse(off.body).answer, null)
})

test('the answer route rejects a malformed body and a wrong method', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, BASE)
  const handler = routes.get('/ask-autopilot/auto-answer')

  const bad = fakeResponse()
  await handler(fakeRequest('{'), bad.res)
  assert.equal(bad.status, 400)

  const method = fakeResponse()
  await handler({ method: 'GET' }, method.res)
  assert.equal(method.status, 405)
})

test('the sound route serves a configured local file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ask-autopilot-'))
  const file = join(directory, 'ding.mp3')
  writeFileSync(file, Buffer.from('ID3fake'))

  const { ctx, routes } = fakeHost()
  apply(ctx, { ...BASE, sound: { ...BASE.sound, source: 'file', file } })
  const handler = routes.get('/ask-autopilot/sound')

  const served = fakeResponse()
  await handler({ method: 'GET' }, served.res)
  assert.equal(served.status, 200)
  assert.equal(served.headers['Content-Type'], 'audio/mpeg')
  assert.equal(served.body.length, 7)

  const unsupported = join(directory, 'note.txt')
  writeFileSync(unsupported, 'x')
  const rejected = fakeHost()
  apply(rejected.ctx, { ...BASE, sound: { ...BASE.sound, source: 'file', file: unsupported } })
  const missing = fakeResponse()
  await rejected.routes.get('/ask-autopilot/sound')({ method: 'GET' }, missing.res)
  assert.equal(missing.status, 415)
})

test('the sound route answers 404 without a configured file', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, BASE)
  const response = fakeResponse()
  await routes.get('/ask-autopilot/sound')({ method: 'GET' }, response.res)
  assert.equal(response.status, 404)
})

/** A request whose async iteration yields the given body once. */
function fakeRequest(body) {
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
}

/** A response recorder with the members the handlers use. */
function fakeResponse() {
  const headers = {}
  const response = {
    status: 0,
    headers,
    body: '',
    res: {
      writeHead(status, extra) {
        response.status = status
        Object.assign(headers, extra ?? {})
      },
      end(chunk) {
        if (chunk === undefined) return
        response.body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      },
    },
  }
  return response
}
