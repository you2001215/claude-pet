# CLAUDE.md — 大肥鱼桌宠（ClaudePet）接手说明

给接手这个项目的 Claude 看的。用户和功能介绍见 README.md，素材来源见 `art-source/README.md` 和 `assets/LICENSE.md`。

## 项目是什么

- Electron 做的 AI 桌宠，支持 Windows 和 macOS（Apple 芯片）。用户主力机是 Windows（华硕），另有一台 M5 Mac。
- 角色：DeepSeek 的拟人鲸鱼娘「大肥鱼」cos 成 Claude。人设写在 `ai.js` 的 `DEFAULT_PERSONA`：被问到时要承认自己是大肥鱼、背后是 DeepSeek，不能冒充 Anthropic 的 Claude。
- 两套造型（右键「换装」）：
  - **Claude 装**：立绘在 `assets/pet/`，部分状态有视频，在 `assets/claude/`。
  - **女仆装**：104 段视频，来自 dsh-pet，在 `assets/maid/`。
- 当前版本 1.5.2，已发布到 GitHub（you2001215/claude-pet）。前面的开发都在云端 Linux 上完成，Windows 安装包用 wine 打包，**还没在真机上验证过**下面几项：
  - Edge 语音在用户的网络下能不能连上；
  - 麦克风识别、扬声器播放；
  - Mac 版能否正常运行。

## 和用户合作

- 用户是游戏策划方向，不写代码，这个项目也是作品集。用中文、用通俗的话交流：
  - 讲清楚改了什么、她看到的效果会有什么不同、怎么试；
  - 少讲实现细节，命令行操作尽量替她做。
- 没有她的要求，不要新建文档或说明文件，有事直接在对话里说。
- API Key 在桌宠的「AI 设置」里填，用 safeStorage 加密存在本机。不要让她把 Key 贴到对话里。
- 推送到 GitHub、发 Release 之前先问她。
- 提交作者用 GitHub 隐私邮箱，不要暴露她的真实邮箱。提交前检查 `git config user.email`，应该是 `97092676+you2001215@users.noreply.github.com`，用户名 `you2001215`。

## 运行和调试

```sh
npm install
npm start        # prestart 会先跑 scripts/fetch-sherpa.js，下载离线语音引擎到 vendor/（约 90 MB，不进 git）
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
- **自动化检查：** `PET_TEST=./某脚本.js npm start` 会加载这个脚本，参数是一个返回桌宠窗口的函数。测试钩子有两组：
  - 主进程的 `global.__pet`：`speakUp`、`voice`、`setOutfit`、`openChat`、`ai`……
  - 渲染进程的 `window.__pet`：`setState`、`walk`、`click`、`pat`、`act`、`line`、`whisperNow`、`lookClip`、`bubble`……
  - 以前的测试脚本没进仓库，需要时现写。最终效果让用户亲眼看一下。

## 代码地图

| 文件 | 作用 |
| --- | --- |
| `main.js` | 主进程：窗口、托盘和右键菜单、设置、`app://` 协议、主动搭话/看屏幕/提醒的定时器、IPC |
| `ai.js` | 调 DeepSeek（OpenAI 兼容接口）：人设、记忆、主动搭话、碎碎念 `whisper()`、余额查询 |
| `reminders.js` | 定时提醒的存取和触发 |
| `stickers.js` | 表情包和梗图：`[sticker:名]` 标记、下载缓存、写进提示词里的清单 |
| `voice/index.js` | 语音总控：设置、清洗要念的文字（`cleanForSpeech`、`forKokoro`）、Edge → Kokoro → 系统语音的降级顺序 |
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
| `scripts/fetch-sherpa.js` | 下载 sherpa-onnx 原生运行库到 `vendor/sherpa` |
| `build/afterPack.js` | 打包后处理：Windows 用 resedit 写图标和版本号；Mac 在设了 `RCODESIGN` 时做 ad-hoc 签名 |

## 踩过的坑（改相关代码前先看）

- **`app://` 协议：** 所有文件都走 `app://pet/...`，`main.js` 用 `fs.promises.readFile` 读（能读 asar 里的文件）。不要改回 `net.fetch(file://)`：中文文件名在 app.asar 里会读失败。`.webm` 走 `serveMedia`，支持 Range，视频才能跳转和循环。
- **Windows 的 GPU 沙箱：** 默认关掉（`disable-gpu-sandbox`）。装了虚拟显示驱动的机器（ToDesk、远程桌面）开着沙箱会崩，这是从 dsh-pet 学来的。
- **离线语音引擎：** sherpa-onnx 返回的原生内存要先 `Float32Array.from` 复制一份，Electron 的 V8 沙箱不允许直接用外部内存。打包后引擎在 `resources/sherpa`，由 package.json 的 `extraResources` 拷进去。
- **Kokoro 的文字预处理：** Claude 要写成「克劳德」，DeepSeek 写成「迪普西克」；`13:30` 要转成「13点30分」；字母前的「！」要换掉；括号里的动作描写不念。这些都在 `forKokoro` 和 `cleanForSpeech` 里。
- **视频片段规格：** 640×360，脚底在 (319, 329)，头顶 y=63。Claude 装从头顶到脚 258 px，和立绘一样大。`process_clip.py` 依赖 Python 的 numpy、pillow、scipy 和 ffmpeg。
- **改默认人设：** 把旧的那段放进 `OLD_PERSONAS`，老用户才会自动迁移到新人设。
- **AI 回复里的控制标记：** `<memory>`、`<remind at="...">`、`<remind-cancel>` 和 `[sticker:名]` 都由程序解析，用户看不到，改提示词时别弄坏格式。

## 打包和发版

1. 改 `package.json` 的 `version`。
2. Windows：在 Windows 上运行 `npm run dist:win`，输出 `dist/ClaudePet-Setup-x.y.z.exe`。
3. Mac：在 Mac 上运行 `npm run dist:mac`，输出的是 `dist/mac-arm64/ClaudePet.app`。
   - `afterPack` 只在设了 `RCODESIGN` 时签名，而 Apple 芯片拒绝运行没签名的程序。
   - 保险起见，在 Mac 上先执行 `codesign --force --deep --sign - dist/mac-arm64/ClaudePet.app`，再用 `ditto -c -k --keepParent dist/mac-arm64/ClaudePet.app dist/ClaudePet-x.y.z-mac-arm64.zip` 打包。
   - 以后可以考虑把这两步写进 `afterPack`。
4. 征得用户同意后，推送代码，再用 `gh release create vX.Y.Z <两个安装包>` 发布。v1.5.2 的 Release 是用户在网页上手动建的。

## 素材和授权（不要破坏）

- 代码用 MIT 协议，`voice/edge-tts.js` 用 LGPL-3.0。
- 所有美术素材都**禁止商用**：
  - 大肥鱼形象：CC BY-NC-SA 4.0；
  - 女仆装视频和梗图：来自 dsh-pet，必须保留署名；
  - 表情包数据：CC BY-NC 4.0，图片在运行时从 kiriyuki.com 下载，不进仓库。
- 不要加任何商业化功能。新加的素材写进 `assets/LICENSE.md` 或对应目录的 NOTICE。

## 待办

- **Claude 装动画：** 已有 12 段：待机、东张西望、原地走路、思考中、说话、挥手打招呼、被摸头、被点开心、傲娇生气、睡觉、打哈欠伸懒腰、吃白饭。`art-source/动画提示词.md` 里还剩 6 条（到点提醒、两条余额、敲键盘、看屏幕、吐泡泡），用户会陆续用 AI 视频工具做好发过来。处理流程：
  1. 先看内容：AI 视频常常时长不对、动作只占一段、带水印或会染色背景的特效，要先裁剪/涂掉再处理（做法见 `art-source/README.md` 的「动画」一行）；
  2. 运行 `python tools/process_clip.py 输入.mp4 assets/claude/动作名.webm 预览.png`，检查预览图；
  3. 在 `assets/claude/clips.json` 里登记时长和循环段（循环段按帧差找最像的两帧）；
  4. 接进 `renderer/pet.js`：「状态 → 片段」写在 `claudeClip()`，键名和女仆装 `clips.json` 一致（walk、think、talk、pat、sulk、greet、clicks、sleep、rest）。叫醒时播 `睡觉` 从 `wakeFrom` 开始的站起来那段；`acts` 是闲着时按时段偶尔做的小动作（`claudeAct()`，每个至少隔 20 分钟），以后做好吐泡泡这类动作就登记到这里。没有片段的状态（坐、拖拽、掉落）仍画立绘。
  5. 新动作做好后，把 `design/亲密度与事件.xlsx`「下拉选项」表里「动作」列对应的「（待做）」去掉，新动作加进去，并同步改命名区域「列表_动作」的范围。
- **Windows 上处理视频：** 用户电脑上用 winget 装了 Python 3.12（`%LOCALAPPDATA%\Programs\Python\Python312`，已装 numpy、pillow、scipy）和 ffmpeg（`Gyan.FFmpeg`）。在 Git Bash 里 `fetch-sherpa.js` 会因为 GNU tar 把 `C:` 当成远程主机而失败，`npm start` 要在 PowerShell 里跑。
- **立绘：** 「喝水」「对着电脑打字」还没生成（提示词在 `art-source/立绘提示词.md`）。
  - 立绘处理没有现成脚本：要抠掉绿幕或白底，再在 `assets/pet/pet.json` 里登记 `feetX`、`feetY`、`headTop`。
  - 还可以用 `art-source/立绘/三视图.jpg`（1500×1500）重新切正面、侧面、背面立绘，让大尺寸显示更清晰。
- **真机验证：** 在 Windows 上用 `npm start` 实际验证 Edge 语音、麦克风、透明视频窗口、托盘菜单。Mac 版按上面的步骤补签名后再试。
