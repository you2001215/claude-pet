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
  - 你用浏览器时偶尔看一眼屏幕点评两句；
  - 输入「余额」查 DeepSeek API 余额。
- **表情包**：大肥鱼表情包和 27 张梗图，她会按语境挑着发。
- **语音**：
  - 她会把回复念出来：Edge 在线语音 → 离线 Kokoro → 系统语音，连不上时自动换下一种；
  - 你可以用麦克风跟她说话，识别在本机离线完成（SenseVoice）。
- **碎碎念**：平时自己嘀咕几句。可以选只用固定台词（不花钱）、偶尔让 AI 现编、尽量让 AI 现编，或者关掉。

## 下载安装

到 [Releases](../../releases) 下载最新版本：

- **Windows**：`ClaudePet-Setup-x.y.z.exe`，双击安装，装好会自动启动。
- **macOS（Apple 芯片）**：`ClaudePet-x.y.z-mac-arm64.zip`，解压后把 `ClaudePet.app` 拖进「应用程序」。程序没有经过苹果公证，第一次打开请**右键 → 打开**；如果提示「已损坏」，在终端运行：

  ```sh
  xattr -cr /Applications/ClaudePet.app
  ```

## 第一次使用

1. 右键她 →「AI 设置」，填 DeepSeek 的 API Key，或者点「从 DeepSeek Harness 导入」。Key 只加密保存在你自己的电脑上。
2. 想跟她语音聊天：在「AI 设置 → 语音」里下载语音识别模型（约 228 MB，只需一次），然后在聊天框点麦克风。
3. 想断网也能听她说话：同一页下载离线语音模型（约 169 MB）。

## 隐私

- 聊天记录、她记住的事、API Key 都只存在本机。
- 看屏幕时截的图只发给你设置的 AI 接口，不存盘。
- 语音识别在本机完成，录音不上传。
- 只有选了 Edge 在线语音时，要念的文字会发给微软合成。

## 自己构建

需要 Node.js 18 以上。

```sh
npm install
npm start          # 第一次会自动下载离线语音引擎（约 90 MB，放在 vendor/）
npm run dist:win   # Windows 安装包，输出到 dist/
npm run dist:mac   # macOS（Apple 芯片），输出到 dist/
```

- 在 Linux 上打 Windows 安装包需要 wine。
- 在 Linux 上打 macOS 版时，把环境变量 `RCODESIGN` 指向 [rcodesign](https://github.com/indygreg/apple-platform-rs) 即可完成 ad-hoc 签名。

### 给 Claude 装加新动画

`art-source/` 里有原始立绘、绿幕视频、首帧图和动画提示词（见 [art-source/README.md](art-source/README.md)）。

1. 按 `art-source/动画提示词.md` 用 AI 视频工具做一段 16:9 的绿幕视频，首帧用 `art-source/首帧/首帧-正面站立.png`。
2. 运行 `python3 tools/process_clip.py 输入.mp4 assets/claude/动作名.webm`。它会抠像、按第一帧把人物大小和位置对齐，输出透明的 VP9 视频。
3. 在 `assets/claude/clips.json` 里登记这个动作。

## 开发方式

由 [you2001215](https://github.com/you2001215) 策划和设计（角色设定、人设、功能与交互、测试与迭代）。代码由 AI 编程助手 Claude（Anthropic）编写。立绘由 Google Gemini 生成，Claude 装动画由 AI 视频工具生成。

## 致谢与授权

- **代码**：MIT，见 [LICENSE](LICENSE)。`voice/edge-tts.js` 移植自 [edge-tts](https://github.com/rany2/edge-tts)，按 LGPL-3.0 授权。
- **素材**（立绘、动画、梗图、表情数据，以及 `art-source/` 里的原始素材）：不适用 MIT，全部禁止商用，见 [assets/LICENSE.md](assets/LICENSE.md)。
  - 大肥鱼形象：原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版设计出自 B 站 [@ZipZipPipe](https://space.bilibili.com/4168597)，CC BY-NC-SA 4.0。
  - 女仆装动画与梗图来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。
  - 表情包作者 B 站 [可以叫我云大人](https://space.bilibili.com/103739)（[kiriyuki.com](https://kiriyuki.com)），数据来自 [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)。
- **第三方组件**：见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
