# dsh-ask-autopilot

[English](README.md) | 中文

AI 提问后如果没人回答，插件替你作答，让回合继续推进，而不是卡在等人。等多久由可配置的时限决定，答什么由推荐方案决定。每次提问还会播放提示音，提示音可以换成你自己的音频文件。

## 做什么

- **自动作答。** `ask_user_question` 等待超过设定时间后，插件替用户作答，回合继续。优先选推荐项：标签以 `(Recommended)` 或 `（推荐）` 结尾的选项；没有这样的选项就选第一个。没有给出选项的问题，用你写的自定义句子作答，默认是「按你的最佳判断继续（用户超时未回复）」。
- **有人正在看的问题不抢答。** 光标停在问题上，或已经开始输入，都会重新计时，所以时限不会在用户正操作时触发。
- **计划审批默认留给人。** 批准计划会直接放行后续实现，因此插件默认不自动作答 `plan-review` 问题，除非你关掉这层保护。
- **提示音。** 每个新出现的提问播放一次。预设音由浏览器合成，不需要文件；也可以换成宿主读取的本地音频文件，或浏览器直接播放的网址。
- **设置页。** 设置里的「提问自动驾驶」可以改等待时间、选择策略、自定义回答和提示音，并带试听按钮。保存立即生效，不需要重新加载。

## 两个时限，一套策略

浏览器半身通过问题卡片结算时限，因为只有走卡片自己的回答通道，卡片才会从输入框位置撤下。宿主半身另外保留一个更晚的时限——设定时间再加一分钟——应对浏览器被关闭、断开或后台限流的情况。两边的选择来自 `index.js` 里的同一套策略；浏览器半身把待答问题提交给宿主路由，而不是重复实现选择规则。

宿主时限还会把 `tool-ask-user` 自带计时等待的到期转换成自动作答，因此两者是叠加关系而不是互相竞争。

## 设置项

在设置页修改，或直接写进 profile 补丁：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 自动作答总开关。 |
| `timeoutMinutes` | `5` | 等待时限，单位分钟，0.1 到 1440。 |
| `strategy` | `recommended` | `recommended`、`first` 或 `skip`。 |
| `optionless` | `custom` | 没有选项的问题怎么处理：填自定义文本或跳过。 |
| `customText` | `按你的最佳判断继续（用户超时未回复）` | 自定义回答。 |
| `skipPlanReview` | `true` | 计划审批留给人。 |
| `sound.enabled` | `true` | 每个提问播放提示音。 |
| `sound.source` | `preset` | `preset`、`file` 或 `url`。 |
| `sound.preset` | `chime` | `chime`、`ding`、`marimba`、`alert`、`soft` 或 `none`。 |
| `sound.file` | 无 | 本地音频路径：mp3、wav、m4a、ogg 或 flac，由宿主读取。 |
| `sound.url` | 无 | 浏览器直接播放的音频网址。 |
| `sound.volume` | `0.6` | 音量，0 到 1。 |

## 限制

- **作答需要问题卡片。** 时限通过卡片结算，所以面板从未渲染过的会话只能靠宿主时限兜底。
- **每个问题只答一次。** 已经进入 `continued` 的问题不会被再次作答；用户先提交的回答永远优先。
- **提示音需要一次交互。** 浏览器在页面被点击或输入之前会挂起音频；之后插件会保持音频图就绪。
- **本地文件对所有访问宿主的页面可读。** 路由只读取配置的那一个路径，从不列目录。
- **路由只监听回环地址。** 宿主把 Web 服务绑定在 `127.0.0.1`，因此这些路由只有本机进程能访问；它们不接受配置写入，也不代表用户作出授权。

## 安装

把 bundle 加进 profile。插件管理器会从 registry 安装：

```text
plugin_manager action=install_bundle target=dsh-ask-autopilot
```

也可以从本地目录安装：把 `target` 指向该目录即可。两个半身都是纯 ESM，不需要构建。

设置保存在 profile 补丁（`~/.dsh/profiles/<profile>/cordis.patch.yml`）的 `ask-autopilot` 行里。字段都是 volatile：保存就地提交，并经由时限所用的同一个读取函数重新读取，因此不会重启插件。

## 开发

用普通 Node 运行本包的测试，不需要构建：

```sh
npm test
```

如果 profile 链接的是本目录而不是从 registry 安装，会遇到 `@deepseek-ai/schemastery` 的 `ERR_MODULE_NOT_FOUND`：pnpm 不会为链接进来的包安装依赖，而宿主按真实路径导入本插件。需要建立一次指向 profile 那一份的联接：

```sh
mkdir -p node_modules/@deepseek-ai
ln -s ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
```

Windows 上请建立目录联接（`cmd /c mklink /J <链接> <目标>`）。从 registry 安装不需要这一步，因为 `@deepseek-ai/schemastery` 是普通依赖。
