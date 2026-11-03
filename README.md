# 大肥鱼桌宠（今天 cos Claude）

一只住在桌面上的 AI 鲸鱼娘：会走来走去、会撒娇、会记住你说过的话、会到点提醒你，还会开口说话。支持 Windows 和 macOS（Apple 芯片）。

![预览](docs/preview.png)

> 非官方同人作品，与 Anthropic、DeepSeek 无关。「大肥鱼」是社区二创形象，不是 DeepSeek 官方形象。仅供个人非商业使用。

## 她能做什么

- **陪在桌面上**：在屏幕底部走动、发呆、犯困睡觉。可以戳她、摸头、拎起来甩出去（会掉下来弹一下）；连戳 5 次她会生气不理你。
- **两套造型**：右键「换装」。
  - **Claude 装**：本项目自己的二创，大肥鱼 cos 成 Claude。
  - **女仆装**：原版大肥鱼，100 多段动画（吃饭、玩魔方、跳舞……），节日和饭点会出现对应动作。
- **AI 聊天（DeepSeek）**：
  - 会记住你告诉她的事；
  - 说一句「17 点提醒我开会」，到点她会来找你；
  - 早上打招呼、你离开回来时招呼你、坐久了提醒你休息；
  - 你用浏览器时偶尔看一眼屏幕点评两句（默认关着，要在「AI 设置 → 看屏幕」里打开）；
  - 输入「余额」查 DeepSeek API 余额。
- **表情包**：大肥鱼表情包和 27 张梗图，她会按语境挑着发。
- **语音**：
  - 她会把回复念出来：Edge 在线语音 → 离线 Kokoro → 系统语音，连不上时自动换下一种；
  - 你可以用麦克风跟她说话，识别在本机离线完成（SenseVoice）。
- **碎碎念**：平时自己嘀咕几句。可以选只用固定台词（不花钱）、偶尔让 AI 现编、尽量让 AI 现编，或者关掉。

## 下载安装

到 [Releases](../../releases) 下载最新版本：

- **Windows**：`ClaudePet-Setup-x.y.z.exe`，双击安装，装好会自动启动。
  - 安装包没有花钱买代码签名证书，Windows 可能弹出蓝色的「Windows 已保护你的电脑」（SmartScreen）。点**更多信息 → 仍要运行**就能装。
- **macOS（Apple 芯片）**：`ClaudePet-x.y.z-mac-arm64.zip`，解压后把 `ClaudePet.app` 拖进「应用程序」。程序没有经过苹果公证，第一次打开请**右键 → 打开**；新版 macOS 上如果还是打不开，到「系统设置 → 隐私与安全性」最下面点「仍要打开」。如果提示「已损坏」，在终端运行：

  ```sh
  xattr -cr /Applications/ClaudePet.app
  ```

- 每个安装包旁边都有一个同名的 `.sha256` 文件，想确认下载的文件没被改过，可以对一下里面的校验值。

## 第一次使用

1. 右键她 →「AI 设置」，填 DeepSeek 的 API Key，或者点「从 DeepSeek Harness 导入」。Key 只加密保存在你自己的电脑上。
2. 想跟她语音聊天：在「AI 设置 → 语音」里下载语音识别模型（约 228 MB，只需一次），然后在聊天框点麦克风。
3. 想断网也能听她说话：同一页下载离线语音模型（约 169 MB）。

## 多台电脑和 AstrBot 共用一个大肥鱼

不设置的话，她的人格、记忆和聊天记录只存在这台电脑上，桌宠完全可以独立使用。想让几台电脑上的她是同一个「她」：

1. 在会自动同步的网盘（OneDrive、iCloud、谷歌云盘、坚果云等）里建一个文件夹。
2. 每台电脑都打开「AI 设置 → 人格和记忆存在哪」，选「存在我选的文件夹里」，再选这个文件夹。
3. 文件夹里会出现这几个文件，以它们为准：
   - `人设.md`：她的人格；
   - `记忆.json`：她记住的关于你的事；
   - `聊天记录.json`：最近的聊天（几台电脑的记录按消息合并，清空过的不会被旧副本带回来）；
   - `陪伴状态.json`：认识的日期、连续见面的天数、今天第一次和最近一次在哪见的。

在一台电脑上聊过、见过，换到另一台电脑她也知道。网盘同步需要一点时间，同一时刻最好只在一台电脑上和她聊。

**和 AstrBot 连起来**：如果你在 QQ 等聊天软件里用 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 养着她，可以装本仓库里的插件 [`integrations/astrbot_plugin_dafeiyu_memory`](integrations/astrbot_plugin_dafeiyu_memory/README.md)，让 AstrBot 读写同一个文件夹（AstrBot 那台机器也要能看到这个文件夹）。插件只在**你本人私聊**时读写记忆、聊天和见面状态；群聊和别人的私聊里不会提起、也不会记下你的事。安装和配置见插件的说明。

## 隐私

- **存在哪**：聊天记录、她记住的事、设置都存在本机的数据目录里（Windows：`%APPDATA%\ClaudePet`，Mac：`~/Library/Application Support/ClaudePet`）。API Key 用系统的加密功能加密保存，不会写进共享文件夹。
- **备份**：数据目录里的 AI 设置、聊天记录和记住的事、提醒、桌宠设置、语音设置，每次保存都先写临时文件再替换，并保留上一份好的版本（`.bak`）。万一文件坏了，她会用备份恢复，坏的那份改名成 `.broken-日期-时间` 留着，不会被覆盖。共享文件夹里不留 `.bak`（会被同步到每台电脑）；那里的 `聊天记录.json`、`陪伴状态.json` 坏了超过 2 分钟，会另存成 `.损坏-日期-时间`，再用这台电脑上的副本重写。
- **发给 AI 的**：你和她说的话、她记住的事、人格，会发给你在设置里填的 AI 接口（默认 DeepSeek）。
- **语音（念出来）**：默认用的是 **Edge 在线语音**，所以她要念的文字会发给微软合成。不想这样，在「AI 设置 → 语音」里改成离线语音（Kokoro）或系统语音，或者把「念出来」关掉。
- **语音（你说话）**：麦克风识别在本机离线完成，录音不上传。
- **看屏幕**：
  - 自动看屏幕**默认关闭**。打开以后，她每次看之前会先冒个气泡说要看一眼；截图只发给你设置的 AI 接口，不存盘。
  - Mac：第一次要先右键点一次「看看我在看什么」，macOS 才会弹出录屏授权，在弹窗里允许，再重启桌宠，自动看屏幕才会开始。每次更新桌宠以后，macOS 可能认不出新版本：到「系统设置 → 隐私与安全性 → 录屏与系统录音」里把 ClaudePet 删掉再加回来。更新后第一次打开如果弹出「ClaudePet Safe Storage」钥匙串提示，选「始终允许」（选「拒绝」的话，保存的 API Key 会像没填过一样）。
  - 在聊天框里点「看屏幕」时，也只把这一张截图发给 AI 接口。
  - 她对屏幕的评论会和普通聊天一样存进聊天记录；用了共享文件夹时也会存进文件夹里的 `聊天记录.json`，装了 AstrBot 插件的话，AstrBot 那边的她也能看到。
- **表情包**：表情包图片在要用时从 kiriyuki.com 下载并缓存在本机。
- **诊断信息**：「AI 设置 → 遇到问题 → 导出诊断信息」（右键菜单里也有）会在你选的位置存一个文本文件，里面没有 API Key、人格、记忆和聊天内容，用户目录和用户名换成了 `~`。只有你自己把它发给别人，别人才看得到。

## 自己构建

需要 Node.js 22.12 以上。

```sh
npm install
npm start          # 第一次会自动下载离线语音引擎（约 90 MB，放在 vendor/）
npm run dist:win   # Windows 安装包，输出到 dist/
npm run dist:mac   # macOS（Apple 芯片），输出到 dist/
```

- 在 Linux 上打 Windows 安装包需要 wine。
- 在 Linux 上打 macOS 版时，把环境变量 `RCODESIGN` 指向 [rcodesign](https://github.com/indygreg/apple-platform-rs) 即可完成 ad-hoc 签名。

### 测试与自动打包

```sh
npm test             # 单元测试：隐藏标记的解析、数据文件的安全读写、提醒、语音文字处理（几秒钟）
npm run test:smoke   # 启动测试：用一个临时的空数据目录真的把桌宠开起来，点一点、换装、开聊天窗和设置页，看有没有报错
```

- 启动测试不会碰你真实的聊天记录和设置，也不会和已经在运行的桌宠冲突。Linux 上没有屏幕时会自动用 `xvfb-run`。
- 每次推送到 GitHub，[GitHub Actions](.github/workflows/build.yml) 会在真正的 Windows 和 Mac（Apple 芯片）上跑这两种测试、打出安装包，再把打好的程序实际启动 20 秒检查。打好的安装包和 `.sha256` 在那次运行页面底部的 Artifacts 里，保留 14 天。
- 推送 `v` 开头的标签（比如 `v1.6.1`）时，会先检查标签和 `package.json` 的版本号一致，再把安装包传到**已经手动建好**的同名 Release 上；Release 不存在就跳过，不会自己创建或发布。

### 给 Claude 装加新动画

`art-source/` 里有原始立绘、绿幕视频、首帧图和动画提示词（见 [art-source/README.md](art-source/README.md)）。

1. 按 `art-source/动画提示词.md` 用 AI 视频工具做一段 16:9 的绿幕视频，首帧用 `art-source/首帧/首帧-正面站立.png`。
2. 先看一遍视频再处理：AI 视频常常时长不对、动作只占其中一段，或者带会把背景染色的特效。先裁掉多余的部分、把会干扰抠像的地方涂成纯绿（做法见 [art-source/README.md](art-source/README.md) 的「动画」一行）。带平台「AI 生成」水印的先别涂掉：2025 年 9 月起施行的 AI 生成内容标识规定不允许恶意删除这类标识，怎么处理还没定。
3. 在仓库根目录运行（Windows 上把 `python3` 换成 `python`）：

   ```sh
   python3 tools/process_clip.py 输入.mp4 assets/claude/动作名.webm 预览.png
   ```

   它会抠像、按第一帧把人物大小和位置对齐，输出透明的 VP9 视频，再看一眼预览图对不对。需要 Python 的 numpy、pillow、scipy 和 ffmpeg。
4. 在 `assets/claude/clips.json` 里登记：
   - 在 `duration` 里写上时长（秒）；要循环播放的动作，再在 `loops` 里写循环段；
   - 闲着时偶尔做的小动作，加进 `acts`（可以用 `hours` 限定时段）；要替换某个状态的动画，就写进对应的键（`walk`、`think`、`talk`、`pat`、`sulk`、`greet`、`clicks`、`sleep`、`rest`、`reminder`、`balance`、`look`）。
5. 只有新加一种「状态」时才需要改 `renderer/pet.js`；放进已有的键或 `acts` 不用改代码。

## 开发方式

由 [you2001215](https://github.com/you2001215) 策划和设计（角色设定、人设、功能与交互、测试与迭代）。代码由 AI 编程助手 Claude（Anthropic）编写。立绘由 Google Gemini 生成，Claude 装动画由 AI 视频工具生成。

## 致谢与授权

- **代码**：MIT，见 [LICENSE](LICENSE)。`voice/edge-tts.js` 移植自 [edge-tts](https://github.com/rany2/edge-tts)，按 LGPL-3.0 授权。
- **素材**（立绘、动画、梗图、表情数据，以及 `art-source/` 里的原始素材）：不适用 MIT，全部禁止商用，见 [assets/LICENSE.md](assets/LICENSE.md)。
  - 大肥鱼形象：原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)，CC BY-NC-SA 4.0。
  - 女仆装动画与梗图来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。
  - 表情包作者 B 站 [可以叫我云大人](https://space.bilibili.com/103739)（[kiriyuki.com](https://kiriyuki.com)），数据来自 [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)。
- **第三方组件**：见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
