/**
 * Ask autopilot, browser half.
 *
 * Two jobs the Host cannot do for itself:
 *
 * 1. Play a notification sound when a question appears, so nobody has to watch
 *    the window.
 * 2. Settle the deadline through the question card, because a card only leaves
 *    the composer seat when its own answer channel is used. The Host half keeps
 *    a later deadline as a backstop for a closed or disconnected browser, and
 *    owns the answer policy so both halves pick the same choice.
 *
 * Settings are read from the Host route rather than from this module, so a save
 * applies to every open window without a reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ask-autopilot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Copy namespace of this plugin's settings page. */
    const NS = 'askAutopilot'
    /** Host routes owned by the package; see the Host half. */
    const CONFIG_ROUTE = '/ask-autopilot/config'
    const SOUND_ROUTE = '/ask-autopilot/sound'
    const ANSWER_ROUTE = '/ask-autopilot/auto-answer'
    /** Settings row id: the Host entry id, which is also the settings namespace. */
    const ENTRY_ID = 'ask-autopilot'
    /** Question scan cadence; a background tab throttles this but never stops it. */
    const SCAN_MS = 5000
    /** How long a fetched settings snapshot is reused before a background refresh. */
    const CONFIG_TTL_MS = 30000
    /** Decoded audio kept per page; sounds are small and reused for every question. */
    const BUFFER_CACHE_SIZE = 8

    /** Accepted values, mirroring the Host schema. */
    const STRATEGIES = ['recommended', 'first', 'skip']
    const OPTIONLESS = ['custom', 'skip']
    const SOUND_SOURCES = ['preset', 'file', 'url']
    const SOUND_PRESETS = ['chime', 'ding', 'marimba', 'alert', 'soft', 'none']
    const MIN_TIMEOUT_MINUTES = 0.1
    const MAX_TIMEOUT_MINUTES = 1440

    /**
     * Settings used before the Host route answers. These mirror the Host schema
     * defaults; the first successful read replaces them.
     */
    const DEFAULTS = {
      enabled: true,
      timeoutMinutes: 5,
      strategy: 'recommended',
      optionless: 'custom',
      customText: '按你的最佳判断继续（用户超时未回复）',
      skipPlanReview: true,
      sound: { enabled: true, source: 'preset', preset: 'chime', file: '', url: '', volume: 0.6 },
    }

    const zh = {
      nav: '提问自动驾驶',
      title: '提问自动驾驶',
      intro: 'AI 提问后如果没人回答，插件会在设定时间到达时按推荐方案自动作答，让工作继续推进；提问出现时还可以播放提示音。',
      behaviorTitle: '自动作答',
      enabledLabel: '启用自动作答',
      enabledHint: '关闭后不再自动作答，等待与提示音设置仍然保留。',
      timeoutLabel: '等待时间',
      timeoutHint: '从提问出现开始计时；光标停在问题上或正在输入时会重新计时。',
      timeoutUnit: '分钟',
      timeoutInvalid: '请输入 0.1 到 1440 之间的数字。',
      strategyLabel: '超时后选择',
      strategyRecommended: '优先选标记为推荐的选项，没有则选第一个',
      strategyFirst: '一律选第一个选项',
      strategySkip: '跳过，不选任何选项',
      optionlessLabel: '没有选项的问题',
      optionlessCustom: '填入下面的自定义回答',
      optionlessSkip: '跳过',
      customTextLabel: '自定义回答',
      customTextHint: '只在问题没有给出选项时使用；模型会把这句当成你的回答。',
      planReviewLabel: '计划审批不自动作答',
      planReviewHint: '计划审批会直接放行后续实现，建议保持开启，让它等你亲自确认。',
      soundTitle: '提示音',
      soundEnabledLabel: '提问时播放提示音',
      soundEnabledHint: '每个新出现的提问播放一次，用于提醒不在屏幕前的你。',
      soundSourceLabel: '声音来源',
      sourcePreset: '内置预设',
      sourceFile: '本地音频文件',
      sourceUrl: '音频网址',
      presetLabel: '预设',
      presetChime: '铃声',
      presetDing: '叮',
      presetMarimba: '木琴',
      presetAlert: '三连提示',
      presetSoft: '轻音',
      presetNone: '静音',
      fileLabel: '文件路径',
      fileHint: '由宿主读取本机文件后交给浏览器，保存后生效。支持 mp3 / wav / m4a / ogg / flac。',
      urlLabel: '音频网址',
      urlHint: '浏览器直接播放该地址，需要对方允许跨域读取。',
      volumeLabel: '音量',
      preview: '试听',
      save: '保存',
      saving: '正在保存…',
      saved: '已保存，立即生效',
      rejected: '宿主拒绝了这次写入，请重新打开设置页再试',
      failed: '保存失败：',
      loading: '正在读取设置…',
      unavailable: '当前部署未提供该设置表单',
      unavailableHint: '插件可能没有安装在当前 profile，或宿主没有提供设置表单服务。自动作答与提示音仍按 profile 里的配置工作。',
      readOnly: '当前部署不允许写入这项设置',
    }
    const en = {
      nav: 'Ask autopilot',
      title: 'Ask autopilot',
      intro: 'When nobody answers an AI question, this plugin answers it with the recommended choice once the deadline passes, so work keeps moving. It can also play a sound when a question appears.',
      behaviorTitle: 'Automatic answer',
      enabledLabel: 'Enable automatic answers',
      enabledHint: 'Off stops automatic answers; the wait and sound settings are kept.',
      timeoutLabel: 'Wait',
      timeoutHint: 'Counted from when the question appears; focusing the question or typing restarts the count.',
      timeoutUnit: 'minutes',
      timeoutInvalid: 'Enter a number from 0.1 to 1440.',
      strategyLabel: 'On timeout',
      strategyRecommended: 'Prefer the option marked recommended, else the first one',
      strategyFirst: 'Always the first option',
      strategySkip: 'Skip, choosing nothing',
      optionlessLabel: 'Questions without options',
      optionlessCustom: 'Answer with the custom text below',
      optionlessSkip: 'Skip',
      customTextLabel: 'Custom answer',
      customTextHint: 'Used only when a question offers no options; the model receives this sentence as your answer.',
      planReviewLabel: 'Leave plan reviews to the user',
      planReviewHint: 'Approving a plan releases the implementation, so keep this on to require your own confirmation.',
      soundTitle: 'Notification sound',
      soundEnabledLabel: 'Play a sound for each question',
      soundEnabledHint: 'One sound per newly appeared question, to reach you while you are away from the screen.',
      soundSourceLabel: 'Sound source',
      sourcePreset: 'Built-in preset',
      sourceFile: 'Local audio file',
      sourceUrl: 'Audio URL',
      presetLabel: 'Preset',
      presetChime: 'Chime',
      presetDing: 'Ding',
      presetMarimba: 'Marimba',
      presetAlert: 'Triple alert',
      presetSoft: 'Soft',
      presetNone: 'Silent',
      fileLabel: 'File path',
      fileHint: 'The Host reads the local file and hands it to the browser; applies after saving. mp3 / wav / m4a / ogg / flac.',
      urlLabel: 'Audio URL',
      urlHint: 'Played directly by the browser; the address must allow cross-origin reads.',
      volumeLabel: 'Volume',
      preview: 'Preview',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved and applied',
      rejected: 'The Host rejected this write; reopen the settings page and retry',
      failed: 'Save failed: ',
      loading: 'Reading settings…',
      unavailable: 'This deployment does not provide the settings form',
      unavailableHint: 'The plugin may not be installed in the current profile, or the Host exposes no settings form. Automatic answers and the sound still follow the profile configuration.',
      readOnly: 'This deployment does not allow writing this setting',
    }

    /** Page styles; host theme tokens only. */
    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: '26px' },
      intro: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '12px 14px' },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600, lineHeight: '22px' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '13px', lineHeight: '20px' },
      rowMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
      label: { fontSize: '13px', lineHeight: '20px' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { height: '30px', padding: '0 8px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px' },
      select: { height: '30px', padding: '0 6px', maxWidth: '340px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px' },
      inline: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
      button: { height: '28px', padding: '0 10px', fontSize: '12.5px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: '6px', cursor: 'pointer' },
      primary: { height: '32px', padding: '0 14px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)', background: 'var(--dsw-alias-state-business-primary)', border: '0', borderRadius: '6px', cursor: 'pointer' },
      primaryOff: { height: '32px', padding: '0 14px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: '6px', cursor: 'default' },
      footer: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      noticeOk: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      noticeBad: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      noticeInfo: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      staticBox: { display: 'flex', flexDirection: 'column', gap: '6px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)' },
      check: { width: '16px', height: '16px', margin: '2px 0 0', flex: '0 0 auto', accentColor: 'var(--dsw-alias-state-business-primary)' },
      range: { width: '160px', accentColor: 'var(--dsw-alias-state-business-primary)' },
      number: { height: '30px', width: '90px', padding: '0 8px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px' },
      text: { height: '30px', width: '320px', maxWidth: '100%', padding: '0 8px', fontSize: '13px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '6px' },
    }

    /**
     * Keep one value inside its accepted set.
     * @param value - candidate value.
     * @param accepted - the accepted members.
     * @param fallback - value used for anything else.
     * @returns the accepted member or the fallback.
     */
    function oneOf(value, accepted, fallback) {
      return typeof value === 'string' && accepted.includes(value) ? value : fallback
    }

    /**
     * Read a finite number.
     * @param value - candidate value.
     * @param fallback - value used when the candidate is not a number.
     * @returns the number or the fallback.
     */
    function numberOr(value, fallback) {
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    /**
     * Clamp a volume into the accepted range.
     * @param value - candidate volume.
     * @returns the clamped volume.
     */
    function clamp01(value) {
      return Math.min(1, Math.max(0, value))
    }

    /**
     * Clamp a deadline into the accepted range.
     * @param value - candidate minutes.
     * @returns whole minutes within range.
     */
    function clampMinutes(value) {
      return Math.min(MAX_TIMEOUT_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, value))
    }

    /**
     * Normalize a settings object from the Host route.
     * @param value - parsed route body.
     * @returns settings safe to use.
     */
    function normalizeConfig(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const sound = source.sound !== null && typeof source.sound === 'object' ? source.sound : {}
      return {
        enabled: source.enabled !== false,
        timeoutMinutes: clampMinutes(numberOr(source.timeoutMinutes, DEFAULTS.timeoutMinutes)),
        strategy: oneOf(source.strategy, STRATEGIES, DEFAULTS.strategy),
        optionless: oneOf(source.optionless, OPTIONLESS, DEFAULTS.optionless),
        customText: typeof source.customText === 'string' ? source.customText : DEFAULTS.customText,
        skipPlanReview: source.skipPlanReview !== false,
        sound: {
          enabled: sound.enabled !== false,
          source: oneOf(sound.source, SOUND_SOURCES, DEFAULTS.sound.source),
          preset: oneOf(sound.preset, SOUND_PRESETS, DEFAULTS.sound.preset),
          file: typeof sound.file === 'string' ? sound.file : '',
          url: typeof sound.url === 'string' ? sound.url : '',
          volume: clamp01(numberOr(sound.volume, DEFAULTS.sound.volume)),
        },
      }
    }

    /** Last accepted settings and when they were read. */
    let configCache = { value: normalizeConfig(DEFAULTS), at: 0 }
    /** In-flight settings read, shared by every caller that arrives during it. */
    let configRequest = null

    /**
     * Re-read the Host settings. A failure keeps the last accepted snapshot.
     * @returns settlement of the read.
     */
    function refreshConfig() {
      if (configRequest !== null) return configRequest
      configRequest = (async () => {
        try {
          const response = await fetch(CONFIG_ROUTE, { cache: 'no-store' })
          if (!response.ok) return
          configCache = { value: normalizeConfig(await response.json()), at: Date.now() }
        } catch {
          // No Host route (a deployment without the Web carrier) keeps the
          // defaults, which still answer and still sound.
        } finally {
          configRequest = null
        }
      })()
      return configRequest
    }

    /**
     * Read the settings, refreshing them in the background once they go stale.
     * @returns the last accepted settings.
     */
    function currentConfig() {
      if (configRequest === null && Date.now() - configCache.at > CONFIG_TTL_MS) void refreshConfig()
      return configCache.value
    }

    /** Shared audio graph, built on first use. */
    let audioState = null

    /**
     * Build the shared audio graph.
     * @returns the graph, or null when the browser exposes no Web Audio.
     */
    function audio() {
      if (audioState !== null) return audioState
      const AudioCtor = window.AudioContext ?? window.webkitAudioContext
      if (typeof AudioCtor !== 'function') return null
      try {
        const context = new AudioCtor()
        const gain = context.createGain()
        gain.gain.value = 1
        gain.connect(context.destination)
        audioState = { context, gain }
      } catch {
        return null
      }
      return audioState
    }

    /**
     * Resume the audio graph on the first user gesture. Browsers keep an
     * AudioContext suspended until the page has been interacted with, and a
     * question can arrive long after that.
     * @returns the disposer removing the gesture listeners.
     */
    function installUnlock() {
      const unlock = () => {
        const state = audio()
        if (state === null) return
        if (state.context.state === 'suspended') state.context.resume().catch(() => {})
      }
      const events = ['pointerdown', 'keydown']
      for (const event of events) window.addEventListener(event, unlock, { capture: true })
      return () => {
        for (const event of events) window.removeEventListener(event, unlock, { capture: true })
      }
    }

    /**
     * Play one synthesized preset.
     * @param state - the audio graph.
     * @param preset - preset id.
     */
    function playPreset(state, preset) {
      const now = state.context.currentTime
      const tone = (frequency, start, duration, type, peak) => {
        const oscillator = state.context.createOscillator()
        const envelope = state.context.createGain()
        oscillator.type = type
        oscillator.frequency.setValueAtTime(frequency, start)
        envelope.gain.setValueAtTime(0.0001, start)
        envelope.gain.exponentialRampToValueAtTime(peak, start + 0.012)
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
        oscillator.connect(envelope)
        envelope.connect(state.gain)
        oscillator.start(start)
        oscillator.stop(start + duration + 0.02)
      }
      switch (preset) {
        case 'chime':
          tone(880, now, 0.5, 'sine', 0.5)
          tone(1320, now + 0.09, 0.55, 'sine', 0.22)
          break
        case 'ding':
          tone(1244.5, now, 0.35, 'sine', 0.5)
          break
        case 'marimba':
          tone(523.25, now, 0.32, 'triangle', 0.5)
          tone(783.99, now + 0.11, 0.4, 'triangle', 0.28)
          break
        case 'alert':
          for (let index = 0; index < 3; index += 1) tone(880, now + index * 0.18, 0.12, 'square', 0.2)
          break
        case 'soft':
          tone(440, now, 0.9, 'sine', 0.32)
          break
        default:
          break
      }
    }

    /** Decoded audio by URL, so a repeated question does not refetch its sound. */
    const bufferCache = new Map()

    /**
     * Play an audio resource through the shared graph.
     * @param state - the audio graph.
     * @param url - the Host sound route or an audio URL.
     * @returns settlement once playback started.
     */
    async function playBuffer(state, url) {
      let buffer = bufferCache.get(url)
      if (buffer === undefined) {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) throw new Error(`sound request answered ${String(response.status)}`)
        buffer = await state.context.decodeAudioData(await response.arrayBuffer())
        if (bufferCache.size >= BUFFER_CACHE_SIZE) bufferCache.clear()
        bufferCache.set(url, buffer)
      }
      const source = state.context.createBufferSource()
      source.buffer = buffer
      source.connect(state.gain)
      source.start()
    }

    /**
     * Play the configured notification sound.
     *
     * Playback failures are contained: a suspended context, an unreadable file,
     * an unsupported format, or a blocked cross-origin URL must never disturb
     * the deadline that the same watcher is counting, and must not surface as
     * an unhandled rejection from a fire-and-forget call.
     *
     * @param sound - the sound settings to use.
     * @returns settlement once playback was attempted.
     */
    async function playSound(sound) {
      if (sound === null || typeof sound !== 'object' || sound.enabled === false) return
      if (sound.source === 'preset' && sound.preset === 'none') return
      const state = audio()
      if (state === null) return
      try {
        if (state.context.state === 'suspended') await state.context.resume()
        if (state.context.state !== 'running') return
        state.gain.gain.value = clamp01(numberOr(sound.volume, DEFAULTS.sound.volume))
        if (sound.source === 'preset') {
          playPreset(state, sound.preset)
          return
        }
        const url = sound.source === 'url' ? sound.url : SOUND_ROUTE
        if (typeof url !== 'string' || url.trim() === '') return
        await playBuffer(state, url.trim())
      } catch {
        // An unreadable file, an unsupported format, a blocked cross-origin URL,
        // or an audio graph the browser refuses stays silent; the settings page
        // reports what the sound is configured to.
      }
    }

    /**
     * Ask the Host for the automatic answer and submit it through the card.
     *
     * Going through the card is what removes it: the card owns the answer
     * channel, and the Host's own deadline is the backstop when this fails.
     *
     * @param interaction - the published question card.
     * @returns settlement once the card accepted or refused the batch.
     */
    async function answerCard(interaction) {
      if (typeof interaction.answer !== 'function') return
      let payload
      try {
        const response = await fetch(ANSWER_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions: interaction.questions }),
        })
        if (!response.ok) return
        payload = await response.json()
      } catch {
        return
      }
      const answer = payload !== null && typeof payload === 'object' ? payload.answer : undefined
      if (answer === null || answer === undefined) return
      try {
        await interaction.answer(answer)
      } catch {
        // A settlement the card refused (a reply already queued, no channel yet)
        // leaves the question to the Host half's deadline.
      }
    }

    /**
     * Watch the published question cards: sound for each new one, and the
     * deadline for the ones nobody answered.
     *
     * Cards come from the Session pending-interaction registry rather than the
     * forwarded request, so this sees a question regardless of which listener
     * claims that request, and keeps running while the panel is hidden.
     *
     * A read-only review card is skipped: it shows a question that already
     * settled, so it has no answer channel and nothing to wait for. A card
     * whose automatic answer was refused stays tracked as attempted, so it
     * neither sounds again nor retries — the Host half's own deadline is the
     * remaining path, and it answers through the request rather than the card.
     *
     * @param uiSession - the Session UI service publishing pending interactions.
     * @returns the disposer stopping the watcher.
     */
    function watchQuestions(uiSession) {
      const tracked = new Map()
      /** The first scan records what is already pending instead of sounding for it. */
      let seeded = false
      const status = uiSession.sessionStatus

      const scan = () => {
        if (status === undefined || status === null || typeof status.getSnapshot !== 'function') return
        const snapshot = status.getSnapshot()
        if (snapshot === undefined || snapshot === null || typeof snapshot.forEach !== 'function') return
        const settings = currentConfig()
        const now = Date.now()
        const seen = new Set()
        snapshot.forEach((entry) => {
          const interaction = entry === undefined || entry === null ? undefined : entry.pendingInteraction
          if (interaction === undefined || interaction === null) return
          if (interaction.kind !== 'question' && interaction.kind !== 'plan-review') return
          // A review card presents a settled question; it accepts no answer.
          if (interaction.review !== undefined) return
          const key = typeof interaction.key === 'string' ? interaction.key : undefined
          if (key === undefined) return
          seen.add(key)
          const state = typeof interaction.getSnapshot === 'function' ? interaction.getSnapshot() : undefined
          // A continued question already left the foreground wait; answering it
          // would open a new turn the model has moved past.
          if (state !== undefined && state !== null && state.state === 'continued') {
            tracked.delete(key)
            return
          }
          const present = state !== undefined && state !== null
            && (state.waitState === 'focused' || state.waitState === 'editing' || state.waitState === 'waiting')
          const record = tracked.get(key)
          if (record === undefined) {
            tracked.set(key, { interaction, deadline: now + settings.timeoutMinutes * 60_000, attempted: false })
            if (seeded && settings.sound.enabled) void playSound(settings.sound)
            return
          }
          record.interaction = interaction
          // Someone is reading or typing an answer: restart the count rather
          // than answering over them.
          if (present) {
            record.deadline = now + settings.timeoutMinutes * 60_000
            return
          }
          if (record.attempted || now < record.deadline || !settings.enabled) return
          // The card answers only through a live waterfall channel; before one
          // is attached there is nothing to settle yet.
          if (state !== undefined && state !== null && state.channel !== 'waterfall') return
          record.attempted = true
          void answerCard(interaction)
        })
        seeded = true
        for (const key of [...tracked.keys()]) if (!seen.has(key)) tracked.delete(key)
      }

      const unsubscribe = status !== undefined && status !== null && typeof status.subscribe === 'function'
        ? status.subscribe(scan)
        : () => {}
      const interval = setInterval(scan, SCAN_MS)
      const onVisibility = () => scan()
      document.addEventListener('visibilitychange', onVisibility)
      scan()
      return () => {
        unsubscribe()
        clearInterval(interval)
        document.removeEventListener('visibilitychange', onVisibility)
        tracked.clear()
      }
    }

    /**
     * Turn a resolved settings section into editable draft values.
     * @param value - resolved section, possibly absent.
     * @returns the draft.
     */
    function draftFrom(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const sound = source.sound !== null && typeof source.sound === 'object' ? source.sound : {}
      return {
        enabled: source.enabled !== false,
        timeoutMinutes: String(numberOr(source.timeoutMinutes, DEFAULTS.timeoutMinutes)),
        strategy: oneOf(source.strategy, STRATEGIES, DEFAULTS.strategy),
        optionless: oneOf(source.optionless, OPTIONLESS, DEFAULTS.optionless),
        customText: typeof source.customText === 'string' ? source.customText : DEFAULTS.customText,
        skipPlanReview: source.skipPlanReview !== false,
        sound: {
          enabled: sound.enabled !== false,
          source: oneOf(sound.source, SOUND_SOURCES, DEFAULTS.sound.source),
          preset: oneOf(sound.preset, SOUND_PRESETS, DEFAULTS.sound.preset),
          file: typeof sound.file === 'string' ? sound.file : '',
          url: typeof sound.url === 'string' ? sound.url : '',
          volume: clamp01(numberOr(sound.volume, DEFAULTS.sound.volume)),
        },
      }
    }

    /**
     * Build the field writes for one save.
     * @param draft - validated draft.
     * @param minutes - validated deadline in minutes.
     * @returns path operations for the settings document.
     */
    function draftOps(draft, minutes) {
      return [
        { op: 'set', path: ['enabled'], value: draft.enabled },
        { op: 'set', path: ['timeoutMinutes'], value: minutes },
        { op: 'set', path: ['strategy'], value: draft.strategy },
        { op: 'set', path: ['optionless'], value: draft.optionless },
        { op: 'set', path: ['customText'], value: draft.customText },
        { op: 'set', path: ['skipPlanReview'], value: draft.skipPlanReview },
        { op: 'set', path: ['sound', 'enabled'], value: draft.sound.enabled },
        { op: 'set', path: ['sound', 'source'], value: draft.sound.source },
        { op: 'set', path: ['sound', 'preset'], value: draft.sound.preset },
        { op: 'set', path: ['sound', 'file'], value: draft.sound.file.trim() },
        { op: 'set', path: ['sound', 'url'], value: draft.sound.url.trim() },
        { op: 'set', path: ['sound', 'volume'], value: draft.sound.volume },
      ]
    }

    /**
     * Describe one thrown value for the page.
     * @param error - thrown value.
     * @returns a readable message.
     */
    function messageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      try {
        return String(error)
      } catch {
        return ''
      }
    }

    /**
     * Translate one key in the active locale.
     * @param ctx - client context.
     * @param key - dictionary key.
     * @returns the localized text.
     */
    function translate(ctx, key) {
      try {
        return ctx.locale.bind(NS)(key)
      } catch {
        return key
      }
    }

    /**
     * Re-render on a locale switch.
     * @param ctx - client context.
     */
    function useLocale(ctx) {
      const [, bump] = React.useState(0)
      React.useEffect(() => ctx.locale.subscribe(() => bump(current => current + 1)), [ctx])
    }

    /**
     * Observe one configuration form snapshot.
     * @param form - the settings form bound to this plugin's row.
     * @returns the current snapshot.
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => {
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])
      return snapshot
    }

    /**
     * One labelled row with an optional hint and a right-aligned control.
     * @param props - label, hint, and control.
     * @returns the row element.
     */
    function Row(props) {
      return h('div', { style: S.row }, [
        h('div', { key: 'main', style: S.rowMain }, [
          h('span', { key: 'label', style: S.label }, props.label),
          props.hint === undefined ? null : h('p', { key: 'hint', style: S.hint }, props.hint),
        ]),
        h('div', { key: 'control', style: S.inline }, props.children),
      ])
    }

    /**
     * One checkbox row, with the control before its label.
     * @param props - label, hint, checked, and change handler.
     * @returns the row element.
     */
    function Toggle(props) {
      return h('div', { style: S.row }, [
        h('input', {
          key: 'control',
          type: 'checkbox',
          style: S.check,
          checked: props.checked,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('div', { key: 'main', style: S.rowMain }, [
          h('span', { key: 'label', style: S.label }, props.label),
          props.hint === undefined ? null : h('p', { key: 'hint', style: S.hint }, props.hint),
        ]),
      ])
    }

    /**
     * One select row.
     * @param props - label, hint, value, options, and change handler.
     * @returns the row element.
     */
    function SelectRow(props) {
      return h(Row, { label: props.label, hint: props.hint },
        h('select', {
          style: S.select,
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }, props.options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
    }

    /**
     * The settings page: resolves the form, then renders the editor.
     * @param props - client context and standard slot props.
     * @returns the page element.
     */
    function SettingsPage(props) {
      const ctx = props.ctx
      useLocale(ctx)
      const t = key => translate(ctx, key)
      const form = formFor(ctx)
      if (form === undefined) {
        return h('div', { style: S.staticBox }, [
          h('h3', { key: 'title', style: S.cardTitle }, t('unavailable')),
          h('p', { key: 'hint', style: S.hint }, t('unavailableHint')),
        ])
      }
      return h(SettingsEditor, { form, t })
    }

    /**
     * The editable page over one configuration form.
     * @param props - the form and the translator.
     * @returns the page element.
     */
    function SettingsEditor(props) {
      const { form, t } = props
      const snapshot = useFormSnapshot(form)
      const [draft, setDraft] = React.useState(() => draftFrom(snapshot.value))
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        setDraft(draftFrom(snapshot.value))
      }, [snapshot.value])

      const patch = (next) => setDraft(current => ({ ...current, ...next }))
      const patchSound = (next) => setDraft(current => ({ ...current, sound: { ...current.sound, ...next } }))
      const writable = snapshot.status === 'ready' && snapshot.writable === true

      const save = () => {
        if (busy || !writable) return
        const minutes = Number(draft.timeoutMinutes)
        if (!Number.isFinite(minutes) || minutes < MIN_TIMEOUT_MINUTES || minutes > MAX_TIMEOUT_MINUTES) {
          setNotice({ tone: 'bad', text: t('timeoutInvalid') })
          return
        }
        setBusy(true)
        setNotice(null)
        let pending
        try {
          pending = form.mutate(draftOps(draft, minutes), snapshot.revision)
        } catch (error) {
          setBusy(false)
          setNotice({ tone: 'bad', text: t('failed') + messageOf(error) })
          return
        }
        Promise.resolve(pending).then(
          (accepted) => {
            setBusy(false)
            setNotice(accepted === false ? { tone: 'bad', text: t('rejected') } : { tone: 'ok', text: t('saved') })
          },
          (error) => {
            setBusy(false)
            setNotice({ tone: 'bad', text: t('failed') + messageOf(error) })
          },
        )
      }

      const preview = () => {
        void playSound({ ...draft.sound, enabled: true })
      }

      const presetOptions = SOUND_PRESETS.map((preset) => ({
        value: preset,
        label: t(`preset${preset.charAt(0).toUpperCase()}${preset.slice(1)}`),
      }))
      const noticeStyle = notice === null
        ? S.noticeInfo
        : notice.tone === 'ok' ? S.noticeOk : S.noticeBad

      return h('div', { style: S.page }, [
        h('h2', { key: 'title', style: S.title }, t('title')),
        h('p', { key: 'intro', style: S.intro }, t('intro')),

        h('div', { key: 'behavior', style: S.card }, [
          h('h3', { key: 'title', style: S.cardTitle }, t('behaviorTitle')),
          h(Toggle, {
            key: 'enabled',
            label: t('enabledLabel'),
            hint: t('enabledHint'),
            checked: draft.enabled,
            onChange: (value) => patch({ enabled: value }),
          }),
          h(Row, { key: 'timeout', label: t('timeoutLabel'), hint: t('timeoutHint') }, [
            h('input', {
              key: 'input',
              type: 'number',
              min: MIN_TIMEOUT_MINUTES,
              max: MAX_TIMEOUT_MINUTES,
              step: 0.5,
              style: S.number,
              value: draft.timeoutMinutes,
              onChange: (event) => patch({ timeoutMinutes: event.target.value }),
            }),
            h('span', { key: 'unit', style: S.hint }, t('timeoutUnit')),
          ]),
          h(SelectRow, {
            key: 'strategy',
            label: t('strategyLabel'),
            value: draft.strategy,
            options: [
              { value: 'recommended', label: t('strategyRecommended') },
              { value: 'first', label: t('strategyFirst') },
              { value: 'skip', label: t('strategySkip') },
            ],
            onChange: (value) => patch({ strategy: value }),
          }),
          h(SelectRow, {
            key: 'optionless',
            label: t('optionlessLabel'),
            value: draft.optionless,
            options: [
              { value: 'custom', label: t('optionlessCustom') },
              { value: 'skip', label: t('optionlessSkip') },
            ],
            onChange: (value) => patch({ optionless: value }),
          }),
          h(Row, { key: 'custom', label: t('customTextLabel'), hint: t('customTextHint') },
            h('input', {
              type: 'text',
              style: S.text,
              value: draft.customText,
              onChange: (event) => patch({ customText: event.target.value }),
            })),
          h(Toggle, {
            key: 'plan-review',
            label: t('planReviewLabel'),
            hint: t('planReviewHint'),
            checked: draft.skipPlanReview,
            onChange: (value) => patch({ skipPlanReview: value }),
          }),
        ]),

        h('div', { key: 'sound', style: S.card }, [
          h('h3', { key: 'title', style: S.cardTitle }, t('soundTitle')),
          h(Toggle, {
            key: 'enabled',
            label: t('soundEnabledLabel'),
            hint: t('soundEnabledHint'),
            checked: draft.sound.enabled,
            onChange: (value) => patchSound({ enabled: value }),
          }),
          h(SelectRow, {
            key: 'source',
            label: t('soundSourceLabel'),
            value: draft.sound.source,
            options: [
              { value: 'preset', label: t('sourcePreset') },
              { value: 'file', label: t('sourceFile') },
              { value: 'url', label: t('sourceUrl') },
            ],
            onChange: (value) => patchSound({ source: value }),
          }),
          draft.sound.source === 'preset'
            ? h(Row, { key: 'preset', label: t('presetLabel') }, [
              h('select', {
                key: 'select',
                style: S.select,
                value: draft.sound.preset,
                onChange: (event) => patchSound({ preset: event.target.value }),
              }, presetOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))),
              h('button', { key: 'preview', type: 'button', style: S.button, onClick: preview }, t('preview')),
            ])
            : null,
          draft.sound.source === 'file'
            ? h(Row, { key: 'file', label: t('fileLabel'), hint: t('fileHint') }, [
              h('input', {
                key: 'input',
                type: 'text',
                style: S.text,
                value: draft.sound.file,
                placeholder: 'D:/sounds/ding.mp3',
                onChange: (event) => patchSound({ file: event.target.value }),
              }),
              h('button', { key: 'preview', type: 'button', style: S.button, onClick: preview }, t('preview')),
            ])
            : null,
          draft.sound.source === 'url'
            ? h(Row, { key: 'url', label: t('urlLabel'), hint: t('urlHint') }, [
              h('input', {
                key: 'input',
                type: 'text',
                style: S.text,
                value: draft.sound.url,
                placeholder: 'https://example.com/ding.mp3',
                onChange: (event) => patchSound({ url: event.target.value }),
              }),
              h('button', { key: 'preview', type: 'button', style: S.button, onClick: preview }, t('preview')),
            ])
            : null,
          h(Row, { key: 'volume', label: t('volumeLabel') },
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              style: S.range,
              value: String(draft.sound.volume),
              onChange: (event) => patchSound({ volume: Number(event.target.value) }),
            })),
        ]),

        h('div', { key: 'footer', style: S.footer }, [
          h('button', {
            key: 'save',
            type: 'button',
            style: writable && !busy ? S.primary : S.primaryOff,
            disabled: !writable || busy,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          h('p', { key: 'notice', style: noticeStyle }, notice === null
            ? (snapshot.status === 'ready' ? '' : t('loading'))
            : notice.text),
          writable ? null : h('p', { key: 'readonly', style: S.noticeInfo }, t('readOnly')),
        ]),
      ])
    }

    /**
     * Bind this plugin's configuration form.
     * @param ctx - client context.
     * @returns the form, or undefined when the deployment exposes none.
     */
    function formFor(ctx) {
      try {
        const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
        if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
        const form = forms.get(ENTRY_ID)
        if (form === undefined || form === null || typeof form.getSnapshot !== 'function') return undefined
        return form
      } catch {
        return undefined
      }
    }

    /** Required client services: the slot registry, copy, and Remote events. */
    const inject = ['slots', 'locale', 'remote']

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const offZh = ctx.locale.register(NS, 'zh', zh)
        const offEn = ctx.locale.register(NS, 'en', en)
        return () => {
          offZh()
          offEn()
        }
      }, 'ask-autopilot: dictionaries')

      ctx.effect(() => installUnlock(), 'ask-autopilot: audio unlock')
      void refreshConfig()

      // A save from any window changes the settings every window reads.
      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => {
        void refreshConfig()
      }), 'ask-autopilot: settings invalidation')

      // The deadline engine needs the Session status registry. Without it the
      // Host half still answers, so this stays an optional dependency.
      ctx.inject(['uiSession'], (scope) => {
        scope.effect(() => watchQuestions(scope.uiSession), 'ask-autopilot: question watcher')
      })

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: ENTRY_ID,
        order: 37,
        label: () => translate(ctx, 'nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, ctx })))
    }

    /**
     * Pure helpers of this half, exported so the package's own tests can pin
     * the settings page's mapping against the Host schema and the Host route's
     * payload against this page's reader.
     */
    const internals = { normalizeConfig, draftFrom, draftOps, clampMinutes }

    return { inject, apply, internals }
  },
})
