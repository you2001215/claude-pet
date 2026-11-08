# CLAUDE.md — 大肥鱼桌宠（ClaudePet）接手说明

给接手这个项目的 Claude 看的。用户和功能介绍见 README.md，素材来源见 `art-source/README.md` 和 `assets/LICENSE.md`。

**先读 `工作档案.md`。** 当前情况、做到哪了、改了什么、备份在哪、下一步、已经讨论过和还要她拍板的事都记在那里。用户要求每次动手前后都在里面记一笔（上半部分「总览」保持最新，下半部分「日志」只往下追加）。

## 项目是什么

- Electron 做的 AI 桌宠，支持 Windows 和 macOS（Apple 芯片）。用户主力机是 Windows（华硕），另有一台 M5 Mac。
- 角色：DeepSeek 的拟人鲸鱼娘「大肥鱼」cos 成 Claude。人设写在 `ai.js` 的 `DEFAULT_PERSONA`：被问到时要承认自己是大肥鱼、背后是 DeepSeek，不能冒充 Anthropic 的 Claude。
- 两套造型（右键「换装」）：
  - **Claude 装**：立绘在 `assets/pet/`，部分状态有视频，在 `assets/claude/`。
  - **女仆装**：104 段视频，来自 dsh-pet，在 `assets/maid/`。
- 发布情况：v1.6.0（Claude 装 18 段动画全部接完，加了共享文件夹）已在 2026-10-28 发布到 GitHub Release（you2001215/claude-pet），之前是 1.5.2。工作分支上是 **1.7.0 测试版，还没正式发布**（1.6.1 的修复 + 连接阿鲸 + 一起看；11-08 用户说先出包，从 GitHub Actions 的产物下载）。前面的开发都在云端 Linux 上完成（Windows 安装包用 wine 打包）；从 1.6.1 起 GitHub Actions 会在真正的 Windows 和 Mac 上打包并跑启动测试（见下面「测试和自动打包」），但下面几项要真人、真设备，**还没在真机上验证过**：
  - Edge 语音在用户的网络下能不能连上；
  - 麦克风识别、扬声器播放；
  - Mac 版能否正常运行。

## 和用户合作

- 用户是游戏策划方向，不写代码，这个项目也是作品集。用中文、用通俗的话交流：
  - 讲清楚改了什么、她看到的效果会有什么不同、怎么试；
  - 少讲实现细节，命令行操作尽量替她做。
- 没有她的要求，不要新建文档或说明文件，有事直接在对话里说。
- **每次回答的最后，把这次要给她看的报告、文件列成一个清单**（文件名 + 先看哪一节），她不想一页页往回翻找。清单里每一项都要能直接点开，不要只写路径：
  - 文件用 SendUserFile 直接发到对话里（display 用 render）；
  - 仓库里的文件再附一个 GitHub 链接（工作分支上的地址，中文路径要 URL 编码）；
  - 安装包给 Actions 产物的直接下载链接（`https://github.com/you2001215/claude-pet/actions/runs/<运行号>/artifacts/<产物号>`）。
- **汇报按优先级一条一条来，不要把所有内容一次堆给她**：P0 底层架构（记忆、心情、连接，不做完链路不成立）→ P1 她和 AstrBot 那边明确提出的核心需求 → P2 影响体验的功能 → P3 同类都有的功能 → P4 附加功能 → P5 锦上添花或费时不讨好。先把需求理解清楚、复述给她确认，再问拍板的事。当前按这个分好的待办在 `工作档案.md` 总览里。
- **测试或任务跑完，不要报一大堆数据**：只讲预测到的风险和错误，以及检测结果。
- API Key 在桌宠的「AI 设置」里填，用 safeStorage 加密存在本机。不要让她把 Key 贴到对话里。
- 推送到 GitHub、发 Release 之前先问她。
- 提交作者用 GitHub 隐私邮箱，不要暴露她的真实邮箱。提交前检查 `git config user.email`，应该是 `97092676+you2001215@users.noreply.github.com`，用户名 `you2001215`。

## 运行和调试

需要 Node.js 22.12 以上（package.json 的 `engines`）。

```sh
npm install
npm start        # prestart 会先跑 scripts/fetch-sherpa.js，下载离线语音引擎到 vendor/（约 90 MB，不进 git）
npm test         # 单元测试（node:test，tests/*.test.js）
npm run test:smoke   # 启动测试：临时空数据目录 + PET_TEST=tests/smoke/pet-smoke.js，Linux 无屏幕时自动套 xvfb-run
npm run test:smoke:link   # 连接阿鲸的启动测试：同上，脚本是 tests/smoke/link-smoke.js，连的是假阿鲸（PET_SMOKE_SHOTS=<文件夹> 会存截图）
npm run test:smoke:watch  # 一起看的启动测试：假阿鲸 + 一个假 B 站页面里跑真的油猴脚本（tests/smoke/watch-smoke.js）
```

- **单实例锁：** 程序有单实例锁，而且开发版和安装版共用同一个用户数据目录。已经装好的桌宠在运行时，`npm start` 会直接退出。先在托盘图标里点「退出」。
- **用户数据目录：** Windows 在 `%APPDATA%\ClaudePet`，Mac 在 `~/Library/Application Support/ClaudePet`。开发版用的就是她真实的聊天记录和设置，改数据格式要小心。目录里的文件：
  - `settings.json`：尺寸、位置、造型；
  - `ai.json`：AI 设置和加密的 Key；
  - `chat.json`：聊天记录和记住的事；
    - 设置里选了「存在我选的文件夹里」时，以那个文件夹为准（`ai.js` 的 `refresh()`），`ai.json`/`chat.json` 里的只是副本。文件夹里有 `人设.md`、`记忆.json`、`聊天记录.json`（按消息 id 合并，`clearedAt` 防止清空后被旧副本带回来）、`陪伴状态.json`（认识日期、连续天数、今天第一次和最近一次在哪见的，`seen()` 更新，开机打招呼据此判断是不是今天第一次见）。这个文件夹可以放在同步盘里，给几台电脑和 AstrBot 插件（`integrations/astrbot_plugin_dafeiyu_memory/`）共用，插件只在主人私聊时读写聊天和状态。以后的亲密度也放在 `陪伴状态.json` 里。
  - `reminders.json`、`voice.json`；
  - `voice-models/`、`stickers/`（缓存）；
  - `error.log`：未捕获的异常都写在这里，不弹窗。
- **环境变量：**
  - `PET_DEBUG=1`：打印找不到的资源；
  - `PET_VOICE_DEBUG=1`：打印语音引擎日志；
  - `PET_GPU_SANDBOX=1`：恢复 Windows 的 GPU 沙箱；
  - `PET_MODEL_SOURCES`、`PET_VOICE_MODELS`：模型下载源和存放目录；
  - `PET_EDGE_WSS`：Edge 语音接口地址；
  - `PET_STICKER_SITE`：表情包站点。
  - 安装版（`app.isPackaged`）会忽略 `PET_TEST`、`PET_EDGE_WSS`、`PET_STICKER_SITE`，只有开发版认它们。
- **自动化检查：** `PET_TEST=./某脚本.js npm start` 会加载这个脚本，参数是一个返回桌宠窗口的函数。测试钩子有两组：
  - 主进程的 `global.__pet`：`speakUp`、`voice`、`setOutfit`、`openChat`、`ai`……
  - 渲染进程的 `window.__pet`：`setState`、`walk`、`click`、`pat`、`act`、`line`、`whisperNow`、`lookClip`、`bubble`……
  - 启动测试 `tests/smoke/pet-smoke.js` 就是这样一个脚本，可以照着写新的检查；结果写到 `PET_SMOKE_OUT`。最终效果让用户亲眼看一下。
  - `scripts/smoke-test.js` 用 `--user-data-dir` 指向临时目录（Linux 另设 `XDG_CONFIG_HOME`，Windows 另设 `APPDATA`），所以不会碰她真实的数据，也不会被单实例锁挡住。临时目录路径别太长：Chromium 的单实例 socket 建在 `TMPDIR` 下，路径超过约 100 字符会直接崩。
- **测试和自动打包：** `.github/workflows/build.yml` 在每次推送 main、`claude/**` 分支和 PR 时运行：Linux 跑单元测试和启动测试；Windows、Mac（Apple 芯片）再各自打包，把打好的程序真的启动 20 秒（不能提前退出、不能写 error.log），安装包和 `.sha256` 作为 Artifacts 保留 14 天。推送 `v*` 标签时先核对标签等于 `v` + package.json 版本，再用 `gh release upload --clobber` 传到她**手动建好**的同名 Release；Release 不存在就跳过，从不创建或发布 Release。
- **诊断信息：** 右键菜单和「AI 设置 → 遇到问题」都能「导出诊断信息…」（`main.js` 的 `diagnosticsText()`、IPC `diag:export`，AI 部分来自 `ai.diagnostics()`）。导出的文本里没有 Key、人设、记忆、聊天内容，用户目录和用户名换成 `~`。她报问题时先让她导一份。

## 代码地图

| 文件 | 作用 |
| --- | --- |
| `main.js` | 主进程：窗口、托盘和右键菜单、设置、`app://` 协议、主动搭话/看屏幕/提醒的定时器、IPC |
| `ai.js` | 调 DeepSeek（OpenAI 兼容接口）：人设、记忆、主动搭话、碎碎念 `whisper()`、余额查询 |
| `store.js` | 安全读写 JSON：先写临时文件（`<文件>.<进程号>-<随机>.tmp`，两个写入方不会撞名）再改名替换，留 `.bak`；读坏的文件改名成 `.broken-日期-时间` 保留，再用 `.bak`；启动时被占用读不出来的文件，之后保存前先另存一份，还读不出来就不覆盖。共享文件夹用异步版（不留 `.bak`，解析出错的消息里不带文件内容）。不依赖 electron |
| `ai-parse.js` | AI 回复里的控制标记：`visible()` 隐藏 `<memory>`/`<remind>`/`<remind-cancel>`/`<think>`，`parseControl()` 读出来并限量（`LIMITS`），`allowCancel()` 只有用户自己说要取消/改时间才放行取消。不依赖 electron |
| `link/` | 桌宠 ↔ AstrBot（阿鲸）的桌面连接，照 `docs/桌面连接接口说明.md`：`protocol.js` 消息格式和地址检查，`client.js` 连接、配对、回执和发件箱、重连（不依赖 electron），`index.js` 开关、设备令牌（加密）、快照、图片，`lines.js` 连着时用的固定台词。默认关着。连着时 `main.js` 的聊天走阿鲸，桌宠自己的 AI 不主动开口 |
| `watch/` | 一起看（阶段 ②，接口说明第 16 节）：`userscript.js` 给 B 站视频页的油猴脚本（只报进度，不读弹幕评论账号，只在主人点「跳过去」时改进度），`server.js` 脚本连的本机接口（只听 127.0.0.1、要口令、拒绝网页），`session.js` 把进度变成 `event.watch`、判断她的话过没过时，`index.js` 设置（`watch.json`）和开关。默认关着；阿鲸那边 `features` 有 `watch` 时才往她那边发 |
| `reminders.js` | 定时提醒的存取和触发（`parseLocal`、`matches` 可单独测试；electron 只在 `init()` 里加载） |
| `stickers.js` | 表情包和梗图：`[sticker:名]` 标记、下载缓存、写进提示词里的清单 |
| `voice/index.js` | 语音总控：设置、Edge → Kokoro → 系统语音的降级顺序 |
| `voice/text.js` | 清洗要念的文字：`cleanForSpeech`、`splitForSpeech`、`forKokoro`（`voice/index.js` 照旧导出它们）。不依赖 electron |
| `voice/edge-tts.js` | Edge 在线语音客户端，含 Sec-MS-GEC 令牌。**本文件按 LGPL-3.0 授权**，改它时保留文件头 |
| `voice/engine-host.js`、`engine-worker.js` | 离线语音引擎（sherpa-onnx）跑在 utilityProcess 里，闲置 15 分钟自动退出 |
| `voice/models.js` | 模型目录（SenseVoice 识别、Kokoro 合成）、下载（hf-mirror 优先，断点续传，sha256 校验） |
| `renderer/pet.js` | 桌宠本体：状态机、物理、拖拽、立绘绘制、气泡、碎碎念、视频片段接入 |
| `renderer/clips.js` | 视频片段播放器 `makeClips(BASE)`：交叉淡入淡出、循环段、节日和饭点筛选。实例有两个：`window.Clips`（女仆）和 `window.ClaudeClips` |
| `renderer/lines.js` | 固定台词表（Claude 装） |
| `assets/maid/lines.json` | 女仆装动作配的台词 |
| `renderer/chat.*`、`settings.*`、`settings-voice.js`、`mic.js`、`mic-worklet.js`、`voice.js` | 聊天窗、设置页、麦克风采集（16 kHz）、宠物端音频播放 |
| `preload.js`、`preload-ui.js` | 桌宠窗口和其他窗口的 IPC 桥 |
| `tools/process_clip.py` | 绿幕视频 → 透明 VP9 webm，按第一帧对齐 |
| `scripts/fetch-sherpa.js` | 下载 sherpa-onnx 原生运行库到 `vendor/sherpa`，解压前核对写死的 sha512（`INTEGRITY`），旁边留 `<包名>.integrity` 标记 |
| `scripts/smoke-test.js`、`tests/smoke/pet-smoke.js` | 启动测试：前者负责开程序、等结果、打印汇总；后者在程序里面点一遍 |
| `tests/*.test.js` | 单元测试（node:test，不需要 electron）：ai-parse、store、reminders、voice/text、link-client、link-store |
| `tests/link/fake-adapter.js` | 假阿鲸：照接口说明写的 AstrBot 桌面适配器替身，只在本机，测试用 |
| `.github/workflows/build.yml` | GitHub Actions：测试、Windows/Mac 打包、启动 20 秒检查、上传 Artifacts、打标签时传到已有的 Release |
| `build/afterPack.js` | 打包后处理：Windows 用 resedit 写图标和版本号；在 Linux 上打 Mac 版时，先翻好 Electron fuses 再用 `RCODESIGN` 做 ad-hoc 签名（在 Mac 上由 electron-builder 自己签） |

## 踩过的坑（改相关代码前先看）

- **`app://` 协议：** 所有文件都走 `app://pet/...`，`main.js` 用 `fs.promises.readFile` 读（能读 asar 里的文件）。不要改回 `net.fetch(file://)`：中文文件名在 app.asar 里会读失败。`.webm` 走 `serveMedia`，支持 Range，视频才能跳转和循环。
- **Windows 的 GPU 沙箱：** 默认关掉（`disable-gpu-sandbox`）。装了虚拟显示驱动的机器（ToDesk、远程桌面）开着沙箱会崩，这是从 dsh-pet 学来的。
- **离线语音引擎：** sherpa-onnx 返回的原生内存要先 `Float32Array.from` 复制一份，Electron 的 V8 沙箱不允许直接用外部内存。打包后引擎在 `resources/sherpa`，由 package.json 的 `extraResources` 拷进去。升级 sherpa-onnx 时，`scripts/fetch-sherpa.js` 里的 `VERSION` 和每个包的 `INTEGRITY`（`npm view <包>@<版本> dist.integrity`）要一起改，`THIRD_PARTY_NOTICES.md` 里 espeak-ng 的源代码版本也要按新版的 `cmake/espeak-ng-for-piper.cmake` 改。
- **数据文件：** 用户数据都经 `store.js` 读写，不要再直接 `fs.writeFileSync`。改格式时只加字段，不改名、不删字段，老文件要能照常读。
- **Electron fuses：** 正式版关了 `runAsNode`、`NODE_OPTIONS`、`--inspect`，只从 `app.asar` 加载（package.json 的 `build.electronFuses`）。**没开** asar 完整性校验：Windows 的 exe 被 `afterPack` 用 resedit 改过、`signAndEditExecutable` 是 false，这个组合没测过。
- **Kokoro 的文字预处理：** Claude 要写成「克劳德」，DeepSeek 写成「迪普西克」；`13:30` 要转成「13点30分」；字母前的「！」要换掉；括号里的动作描写不念。这些都在 `forKokoro` 和 `cleanForSpeech` 里。
- **视频片段规格：** 640×360，脚底在 (319, 329)，头顶 y=63。Claude 装从头顶到脚 258 px，和立绘一样大。`process_clip.py` 依赖 Python 的 numpy、pillow、scipy 和 ffmpeg。
- **改默认人设：** 把旧的那段放进 `OLD_PERSONAS`，老用户才会自动迁移到新人设。
- **AI 回复里的控制标记：** `<memory>`、`<remind at="...">`、`<remind-cancel>` 和 `[sticker:名]` 都由程序解析，用户看不到，改提示词时别弄坏格式。

## 打包和发版

1. 改 `package.json` 的 `version`。
2. Windows：在 Windows 上运行 `npm run dist:win`，输出 `dist/ClaudePet-Setup-x.y.z.exe`。
3. Mac：在 Mac 上运行 `npm run dist:mac`，输出的是 `dist/mac-arm64/ClaudePet.app`。
   - 现在由 electron-builder 自己做 ad-hoc 签名（`build.mac.identity` 是 `"-"`），Apple 芯片才肯运行。可以用 `codesign --verify --deep --strict dist/mac-arm64/ClaudePet.app` 检查。
   - 手动的 `codesign --force --deep --sign - dist/mac-arm64/ClaudePet.app` 只在上面检查不通过时作为后备。然后用 `ditto -c -k --keepParent dist/mac-arm64/ClaudePet.app dist/ClaudePet-x.y.z-mac-arm64.zip` 打包。
   - 在 Linux 上打 Mac 版时仍然靠 `RCODESIGN`（见 `afterPack`）。
   - 省事的做法：推送到 GitHub，让 Actions 在真 Windows、真 Mac 上打好，从 Artifacts 下载（见上面「测试和自动打包」）。
4. 征得用户同意后，推送代码，再用 `gh release create vX.Y.Z <两个安装包>` 发布。v1.5.2 的 Release 是用户在网页上手动建的。
   - 也可以请她先在网页上建好 Release，再推送同名标签，Actions 会自动把两个安装包和 `.sha256` 传上去。

## 素材和授权（不要破坏）

- 代码用 MIT 协议，`voice/edge-tts.js` 用 LGPL-3.0。
- 所有美术素材都**禁止商用**：
  - 大肥鱼形象：CC BY-NC-SA 4.0；
  - 女仆装视频和梗图：来自 dsh-pet，必须保留署名；
  - 表情包数据：CC BY-NC 4.0，图片在运行时从 kiriyuki.com 下载，不进仓库。
- 不要加任何商业化功能。新加的素材写进 `assets/LICENSE.md` 或对应目录的 NOTICE。

## 待办

- **Claude 装动画：** `art-source/动画提示词.md` 里的 18 段全部做完了：待机、东张西望、原地走路、思考中、说话、挥手打招呼、被摸头、被点开心、傲娇生气、睡觉、打哈欠伸懒腰、吃白饭、到点提醒、余额充足、余额见底、敲键盘、看屏幕、吐泡泡。以后再加新动作，处理流程：
  1. 先看内容：AI 视频常常时长不对、动作只占一段、带水印或会染色背景的特效，要先裁剪/涂掉再处理（做法见 `art-source/README.md` 的「动画」一行）；（待用户决定：2025 年 9 月起的 AI 生成内容标识规定不允许恶意删除标识，处理前先问她）
  2. 运行 `python tools/process_clip.py 输入.mp4 assets/claude/动作名.webm 预览.png`，检查预览图；
  3. 在 `assets/claude/clips.json` 里登记时长和循环段（循环段按帧差找最像的两帧）；
  4. 接进 `renderer/pet.js`（放进已有的键或 `acts` 只改 `clips.json` 就行，新加一种状态才要改代码）：「状态 → 片段」写在 `claudeClip()`，键名和女仆装 `clips.json` 一致（walk、think、talk、pat、sulk、greet、clicks、sleep、rest、reminder、balance、look）。叫醒时播 `睡觉` 从 `wakeFrom` 开始的站起来那段；`balance` 按余额档位 0～5 排，空字符串表示那一档不播；`look` 去看屏幕时先播一次再接思考中；`acts` 是闲着时按时段偶尔做的小动作（`claudeAct()`，每个至少隔 20 分钟：吃白饭、敲键盘、吐泡泡）。没有片段的状态（坐、拖拽、掉落）仍画立绘。
  5. 新动作做好后，加进 `design/亲密度与事件.xlsx`「下拉选项」表的「动作」列，并同步改命名区域「列表_动作」的范围。
- **Windows 上处理视频：** 用户电脑上用 winget 装了 Python 3.12（`%LOCALAPPDATA%\Programs\Python\Python312`，已装 numpy、pillow、scipy）和 ffmpeg（`Gyan.FFmpeg`）。在 Git Bash 里 `fetch-sherpa.js` 会因为 GNU tar 把 `C:` 当成远程主机而失败，`npm start` 要在 PowerShell 里跑。
- **立绘：** 「喝水」「对着电脑打字」还没生成（提示词在 `art-source/立绘提示词.md`）。
  - 立绘处理没有现成脚本：要抠掉绿幕或白底，再在 `assets/pet/pet.json` 里登记 `feetX`、`feetY`、`headTop`。
  - 还可以用 `art-source/立绘/三视图.jpg`（1500×1500）重新切正面、侧面、背面立绘，让大尺寸显示更清晰。
- **真机验证：** 在 Windows 上用 `npm start` 实际验证 Edge 语音、麦克风、透明视频窗口、托盘菜单。Mac 版按上面的步骤补签名后再试。
