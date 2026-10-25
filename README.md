# dsh-ask-autopilot

English | [中文](README.zh.md)

Answers an AI question that nobody answered, so a turn does not stall while you are away from the keyboard. A configurable deadline decides when; the recommended choice decides what. A notification sound announces each question, and its source is configurable down to your own audio file.

## What it does

- **Automatic answer.** When `ask_user_question` has been waiting longer than the configured time, the plugin answers it and the turn continues. The recommended option wins: the option whose label ends with `(Recommended)` or `（推荐）`, else the first option. A question with no options is answered with a custom sentence you write, by default "按你的最佳判断继续（用户超时未回复）".
- **A question someone is reading is left alone.** Focusing the question, or starting to type an answer, restarts the countdown, so the deadline never fires over an active user.
- **Plan reviews stay manual by default.** Approving a plan releases implementation, so the plugin refuses to answer a `plan-review` question unless you turn that protection off.
- **Notification sound.** One sound per newly appeared question. Presets are synthesized in the browser and need no file; a local audio file or an `http(s)` URL can replace them.
- **Settings page.** "提问自动驾驶" / "Ask autopilot" in Settings edits the deadline, the strategy, the custom answer, and the sound, with a preview button. Saving applies immediately, without a reload.

## Two deadlines, one policy

The browser half settles the deadline through the question card, because a card only leaves the composer seat when its own answer channel is used. The Host half keeps a later deadline of its own — one minute past the configured time — for a browser that is closed, disconnected, or background-throttled. Both halves take the answer from one policy in `index.js`; the browser posts the pending questions to the Host route instead of repeating the choice rules.

The Host deadline also converts the shipped timed wait's own expiry into an automatic answer, so the plugin composes with `tool-ask-user`'s `timed` mode instead of competing with it.

## Settings

Edited from the settings page or directly in the profile patch:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for automatic answers. |
| `timeoutMinutes` | `5` | Deadline, in minutes, from 0.1 to 1440. |
| `strategy` | `recommended` | `recommended`, `first`, or `skip`. |
| `optionless` | `custom` | What a question without options resolves to: `custom` text or `skip`. |
| `customText` | `按你的最佳判断继续（用户超时未回复）` | The custom answer. |
| `skipPlanReview` | `true` | Leave plan reviews to the user. |
| `sound.enabled` | `true` | Play a sound for each question. |
| `sound.source` | `preset` | `preset`, `file`, or `url`. |
| `sound.preset` | `chime` | `chime`, `ding`, `marimba`, `alert`, `soft`, or `none`. |
| `sound.file` | — | Local audio path: mp3, wav, m4a, ogg, or flac. The Host reads it. |
| `sound.url` | — | Audio URL the browser plays directly. |
| `sound.volume` | `0.6` | Playback volume from 0 to 1. |

## Limits

- **Answering needs a question card.** The deadline is settled through the card, so a Session whose panel never rendered is left to the Host deadline.
- **One answer per question.** A question that already moved on (`continued`) is not answered again; a reply the user submits first always wins.
- **The sound needs a gesture.** Browsers keep audio suspended until the page has been clicked or typed in at least once; after that the plugin keeps the audio graph ready.
- **Local files are served to any page the Host serves.** The route reads one configured path only, and never lists directories.
- **The routes are loopback-only.** The Host binds its Web server to `127.0.0.1`, so only local processes reach them; none of them writes configuration or answers for the user.

## Install

Add the bundle to a profile. The Plugin Manager installs it from the registry:

```text
plugin_manager action=install_bundle target=dsh-ask-autopilot
```

Or install from a local checkout by pointing `target` at the directory instead. Nothing needs building: both halves are plain ESM.

Settings live in the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`) under the `ask-autopilot` row, because the fields are volatile: a save commits in place and re-reads through the same accessor the deadline uses, so nothing restarts.

## Develop

Run the package's tests with plain Node, no build step:

```sh
npm test
```

A profile that links this directory instead of installing it from the registry hits `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/schemastery`: pnpm does not install a linked package's dependencies, and the Host imports the plugin through its real path. Link the profile's copy once:

```sh
mkdir -p node_modules/@deepseek-ai
ln -s ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
```

On Windows use a directory junction: `cmd /c mklink /J <link> <target>`. A registry install needs none of this, because `@deepseek-ai/schemastery` is a regular dependency.

Switching a profile from a linked checkout to the registry package can fail with `ERR_PNPM_EPERM` on Windows while the Host holds the old directory. Remove the stale link from the profile's `node_modules` and install again; nothing else is needed.
