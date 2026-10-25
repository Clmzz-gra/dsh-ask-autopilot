/**
 * Ask autopilot, Host half.
 *
 * The plugin answers an unanswered `ask_user_question` after a configured
 * deadline so a turn does not stall while nobody is at the keyboard.
 *
 * Two owners, one policy. The browser half normally settles the deadline
 * itself, because only it can resolve the question card the user is looking
 * at; this half keeps a later deadline of its own for a browser that is
 * closed, disconnected, or throttled in the background. Both call the answer
 * policy exported from this file instead of re-implementing it, and the
 * browser reaches it over {@link ANSWER_ROUTE}.
 *
 * The same half serves the browser its resolved settings and, when the
 * configured sound is a local file, the audio bytes over {@link SOUND_ROUTE}.
 *
 * Model experience: the automatic answer is indistinguishable from a human
 * pick in the tool result. A question without options carries the configured
 * custom text, which is the place to state that no human answered.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'ask-autopilot'

/** Browser routes owned by this package; exact paths, so they shadow nothing. */
const CONFIG_ROUTE = '/ask-autopilot/config'
const SOUND_ROUTE = '/ask-autopilot/sound'
const ANSWER_ROUTE = '/ask-autopilot/auto-answer'

/**
 * Extra wait the Host grants the browser before answering on its own. The two
 * halves share one deadline, and the browser settles the card the user sees;
 * this margin keeps the Host from stealing the answer while the browser is
 * merely slow, including a background tab whose timers are throttled.
 */
const HOST_GRACE_MS = 60_000

/** Largest sound file the route will serve, and the only extensions it serves. */
const MAX_SOUND_BYTES = 20 * 1024 * 1024
const SOUND_CONTENT_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.weba', 'audio/webm'],
  ['.webm', 'audio/webm'],
])

/** Largest request body the answer route accepts, in bytes. */
const MAX_REQUEST_BYTES = 1024 * 1024

/** Selection strategies, in the order the settings page lists them. */
export const STRATEGIES = ['recommended', 'first', 'skip']
/** What an optionless question resolves to. */
export const OPTIONLESS = ['custom', 'skip']
/** Where the notification sound comes from. */
export const SOUND_SOURCES = ['preset', 'file', 'url']
/** Built-in synthesized sounds; `none` is silent. */
export const SOUND_PRESETS = ['chime', 'ding', 'marimba', 'alert', 'soft', 'none']

/** Accepted deadline range, in minutes. */
export const MIN_TIMEOUT_MINUTES = 0.1
export const MAX_TIMEOUT_MINUTES = 1440

/** Values used when a field is absent or unreadable. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMinutes: 5,
  strategy: 'recommended',
  optionless: 'custom',
  customText: '按你的最佳判断继续（用户超时未回复）',
  skipPlanReview: true,
  sound: Object.freeze({
    enabled: true,
    source: 'preset',
    preset: 'chime',
    file: '',
    url: '',
    volume: 0.6,
  }),
})

/**
 * Fields the settings page may edit. Every leaf is volatile, so a save commits
 * in place and re-reads through {@link readSettings} instead of restarting the
 * plugin; a non-volatile field would not appear in the settings form at all.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  timeoutMinutes: z.number()
    .min(MIN_TIMEOUT_MINUTES)
    .max(MAX_TIMEOUT_MINUTES)
    .default(DEFAULTS.timeoutMinutes)
    .volatile(),
  strategy: z.union(STRATEGIES).default(DEFAULTS.strategy).volatile(),
  optionless: z.union(OPTIONLESS).default(DEFAULTS.optionless).volatile(),
  customText: z.string().default(DEFAULTS.customText).volatile(),
  skipPlanReview: z.boolean().default(DEFAULTS.skipPlanReview).volatile(),
  sound: z.object({
    enabled: z.boolean().default(DEFAULTS.sound.enabled).volatile(),
    source: z.union(SOUND_SOURCES).default(DEFAULTS.sound.source).volatile(),
    preset: z.union(SOUND_PRESETS).default(DEFAULTS.sound.preset).volatile(),
    file: z.string().default(DEFAULTS.sound.file).volatile(),
    url: z.string().default(DEFAULTS.sound.url).volatile(),
    volume: z.number().min(0).max(1).default(DEFAULTS.sound.volume).volatile(),
  }),
})

/**
 * Read a field that may be a live volatile reference.
 * @param value - plain value, `Volatile` reference, or absence.
 * @param fallback - value used when the reference cannot be read.
 * @returns the current plain value.
 */
function plain(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined || current === null ? fallback : current
    } catch {
      // A volatile reference whose fiber is gone reads as absent; defaults still answer.
      return fallback
    }
  }
  return value
}

/**
 * Keep one field inside its accepted set.
 * @param value - candidate value.
 * @param accepted - the accepted members.
 * @param fallback - value used for anything else.
 * @returns the accepted member or the fallback.
 */
function oneOf(value, accepted, fallback) {
  return typeof value === 'string' && accepted.includes(value) ? value : fallback
}

/**
 * Clamp the deadline into the schema range.
 * @param value - candidate minutes.
 * @returns whole milliseconds within the accepted range.
 */
function timeoutMs(value) {
  const minutes = Number.isFinite(value) ? value : DEFAULTS.timeoutMinutes
  const clamped = Math.min(MAX_TIMEOUT_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, minutes))
  return Math.round(clamped * 60_000)
}

/**
 * Resolve the plugin configuration into the shape the answer policy and the
 * browser both consume.
 * @param config - the row's resolved Config, absent in a bare test import.
 * @returns the normalized settings.
 */
export function readSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const sound = plain(source.sound, DEFAULTS.sound)
  const soundObject = sound !== null && typeof sound === 'object' ? sound : DEFAULTS.sound
  const customText = plain(source.customText, DEFAULTS.customText)
  const file = plain(soundObject.file, DEFAULTS.sound.file)
  const url = plain(soundObject.url, DEFAULTS.sound.url)
  const volume = Number(plain(soundObject.volume, DEFAULTS.sound.volume))
  return {
    enabled: plain(source.enabled, DEFAULTS.enabled) !== false,
    timeoutMs: timeoutMs(Number(plain(source.timeoutMinutes, DEFAULTS.timeoutMinutes))),
    strategy: oneOf(plain(source.strategy, DEFAULTS.strategy), STRATEGIES, DEFAULTS.strategy),
    optionless: oneOf(plain(source.optionless, DEFAULTS.optionless), OPTIONLESS, DEFAULTS.optionless),
    customText: typeof customText === 'string' ? customText : DEFAULTS.customText,
    skipPlanReview: plain(source.skipPlanReview, DEFAULTS.skipPlanReview) !== false,
    sound: {
      enabled: plain(soundObject.enabled, DEFAULTS.sound.enabled) !== false,
      source: oneOf(plain(soundObject.source, DEFAULTS.sound.source), SOUND_SOURCES, DEFAULTS.sound.source),
      preset: oneOf(plain(soundObject.preset, DEFAULTS.sound.preset), SOUND_PRESETS, DEFAULTS.sound.preset),
      file: typeof file === 'string' ? file : DEFAULTS.sound.file,
      url: typeof url === 'string' ? url : DEFAULTS.sound.url,
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULTS.sound.volume,
    },
  }
}

/**
 * The settings subset the browser needs, over the wire.
 * @param settings - output of {@link readSettings}.
 * @returns JSON-safe settings with the deadline in minutes.
 */
export function wireSettings(settings) {
  return {
    enabled: settings.enabled,
    timeoutMinutes: settings.timeoutMs / 60_000,
    strategy: settings.strategy,
    optionless: settings.optionless,
    customText: settings.customText,
    skipPlanReview: settings.skipPlanReview,
    sound: { ...settings.sound },
  }
}

/**
 * Label suffix that marks an option as the recommended one. Mirrors the Web
 * question card, which preselects an option marked this way in either language
 * and either bracket width.
 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/**
 * Find the recommended option.
 * @param options - the question's options.
 * @returns the first label carrying the recommendation marker, if any.
 */
function recommendedLabel(options) {
  for (const option of options) {
    const label = option?.label
    if (typeof label === 'string' && RECOMMENDED_SUFFIX.test(label)) return label
  }
  return undefined
}

/**
 * Answer one question the way an absent user would have.
 * @param question - one question of the pending batch.
 * @param settings - resolved settings.
 * @returns the answer item for that question.
 */
function autoAnswerItem(question, settings) {
  const options = Array.isArray(question.options) ? question.options.filter(option => typeof option?.label === 'string') : []
  if (options.length === 0) {
    const custom = settings.customText.trim()
    return settings.optionless === 'custom' && custom !== ''
      ? { id: question.id, selected: [], custom }
      : { id: question.id, selected: [] }
  }
  if (settings.strategy === 'skip') return { id: question.id, selected: [] }
  const picked = settings.strategy === 'first'
    ? options[0].label
    : recommendedLabel(options) ?? options[0].label
  return { id: question.id, selected: [picked] }
}

/**
 * Build the answer batch for one pending question request.
 * @param questions - the request's questions.
 * @param settings - resolved settings.
 * @returns one answer item per question, in request order.
 */
export function autoAnswer(questions, settings) {
  return { answers: questions.map(question => autoAnswerItem(question, settings)) }
}

/**
 * Whether this request is one the plugin may answer.
 * @param questions - the request's questions.
 * @param settings - resolved settings.
 * @returns false for an empty batch, or for a plan review the user asked to keep manual.
 */
export function answerable(questions, settings) {
  if (!Array.isArray(questions) || questions.length === 0) return false
  if (!settings.skipPlanReview) return true
  return !questions.some(question => question?.intent?.kind === 'plan-review')
}

/**
 * Whether a failure is the shipped timed wait expiring.
 * @param error - rejection from the downstream answerer.
 * @returns true for `ASK_TIMED_OUT`.
 */
function isTimedOut(error) {
  return typeof error === 'object' && error !== null && error.code === 'ASK_TIMED_OUT'
}

/**
 * One timer whose cancellation clears the underlying handle.
 * @param ms - delay in milliseconds.
 * @returns the expiry promise and its cancel function.
 */
function timer(ms) {
  let handle
  const expired = new Promise((settle) => {
    handle = setTimeout(settle, ms)
  })
  return { expired, cancel: () => clearTimeout(handle) }
}

/**
 * Race the human answer against this half's deadline.
 *
 * The downstream answerer is never abandoned silently: its settlement is
 * observed either way, so a late rejection (a turn cancel, or a card the user
 * closed) cannot surface as an unhandled rejection after this listener has
 * already returned.
 *
 * @param upstream - the downstream answerer's pending answer.
 * @param questions - the request's questions, for the automatic answer.
 * @param settings - resolved settings.
 * @returns the human answer, the automatic answer, or the downstream failure.
 */
async function settleWithDeadline(upstream, questions, settings) {
  const settled = upstream.then(
    answer => ({ kind: 'answer', answer }),
    error => ({ kind: 'error', error }),
  )
  const deadline = timer(settings.timeoutMs + HOST_GRACE_MS)
  try {
    const outcome = await Promise.race([
      settled,
      deadline.expired.then(() => ({ kind: 'deadline' })),
    ])
    if (outcome.kind === 'answer') return outcome.answer
    // A shipped timed wait that expired first means the same thing this plugin
    // exists for: nobody answered. Turn that pending release into the answer.
    if (outcome.kind === 'error') {
      if (isTimedOut(outcome.error)) return autoAnswer(questions, settings)
      throw outcome.error
    }
    return autoAnswer(questions, settings)
  } finally {
    deadline.cancel()
  }
}

/**
 * Read and validate the questions a browser posts for an automatic answer.
 * The browser is the only caller, but this crosses the HTTP boundary, so the
 * payload is checked rather than trusted.
 * @param value - parsed request body.
 * @returns the questions, or undefined when the payload is unusable.
 */
export function parseQuestions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const questions = value.questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const parsed = []
  for (const question of questions) {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) return undefined
    if (typeof question.id !== 'string' || typeof question.question !== 'string') return undefined
    const options = []
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) return undefined
      for (const option of question.options) {
        if (option === null || typeof option !== 'object' || typeof option.label !== 'string') return undefined
        options.push(typeof option.description === 'string'
          ? { label: option.label, description: option.description }
          : { label: option.label })
      }
    }
    const item = { id: question.id, question: question.question }
    if (options.length > 0) item.options = options
    if (question.multiSelect === true) item.multiSelect = true
    if (question.intent !== undefined) {
      if (question.intent === null || typeof question.intent !== 'object') return undefined
      if (typeof question.intent.kind !== 'string') return undefined
      item.intent = question.intent.kind === 'plan-review' && typeof question.intent.approve === 'string'
        ? { kind: 'plan-review', approve: question.intent.approve }
        : { kind: question.intent.kind }
    }
    parsed.push(item)
  }
  return parsed
}

/**
 * Read a request body with a size ceiling.
 * @param req - the incoming request.
 * @returns the body text, or undefined when it exceeds {@link MAX_REQUEST_BYTES}.
 */
async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_REQUEST_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answer one HTTP request with JSON.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param value - JSON-safe body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Serve the configured local sound file.
 * @param res - the response to write.
 * @param file - configured path; empty means no file is configured.
 */
async function sendSound(res, file) {
  if (typeof file !== 'string' || file.trim() === '') {
    res.writeHead(404)
    res.end()
    return
  }
  const target = isAbsolute(file) ? file : resolve(file)
  const contentType = SOUND_CONTENT_TYPES.get(extname(target).toLowerCase())
  if (contentType === undefined) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`ask-autopilot: unsupported sound extension for ${target}`)
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!info.isFile() || info.size > MAX_SOUND_BYTES) {
    res.writeHead(404)
    res.end()
    return
  }
  let bytes
  try {
    bytes = await readFile(target)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
  })
  res.end(bytes)
}

/**
 * Register the deadline answerer and, when a Web carrier exists, the routes the
 * browser half reads.
 * @param ctx - the Host context.
 * @param config - the row's resolved Config.
 */
export function apply(ctx, config) {
  const settings = () => readSettings(config)

  // Prepend so this listener wraps the Web answerer rather than sitting behind
  // it: the chain delegates inward, and only an outer listener can observe the
  // wait without claiming it.
  ctx.on('user-questions/request', (request, next) => {
    const current = settings()
    // A request without an agent is a programmatic caller with no card on
    // screen, so there is no deadline to run: only a question a human could
    // have seen is auto-answered.
    if (request.agent === undefined) return next()
    if (!current.enabled || !answerable(request.questions, current)) return next()
    return settleWithDeadline(next(), request.questions, current)
  }, { global: true, prepend: true })

  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        sendJson(res, 200, wireSettings(settings()))
      },
    }), 'ask-autopilot: settings route')

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: SOUND_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        await sendSound(res, settings().sound.file)
      },
    }), 'ask-autopilot: sound route')

    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: ANSWER_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const body = await readBody(req)
        if (body === undefined) {
          sendJson(res, 413, { answer: null, reason: 'request body too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          sendJson(res, 400, { answer: null, reason: 'request body is not JSON' })
          return
        }
        const questions = parseQuestions(payload)
        if (questions === undefined) {
          sendJson(res, 400, { answer: null, reason: 'questions are missing or malformed' })
          return
        }
        const current = settings()
        if (!current.enabled) {
          sendJson(res, 200, { answer: null, reason: 'ask autopilot is disabled' })
          return
        }
        if (!answerable(questions, current)) {
          sendJson(res, 200, { answer: null, reason: 'this question is left to the user' })
          return
        }
        sendJson(res, 200, { answer: autoAnswer(questions, current) })
      },
    }), 'ask-autopilot: answer route')
  })
}
