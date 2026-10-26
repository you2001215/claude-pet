# 第三方组件与服务

## 随程序一起发布的

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 程序外壳（含 Chromium、Node.js） | MIT（Chromium 各组件许可见安装目录 `LICENSES.chromium.html`） |
| [ws](https://github.com/websockets/ws) | Edge 语音的 WebSocket 连接 | MIT |
| [yaml](https://github.com/eemeli/yaml) | 读取 DeepSeek Harness 配置 | ISC |
| [sherpa-onnx / sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) | 离线语音合成与识别引擎（打包在安装包的 `resources/sherpa`） | Apache-2.0（见 `LICENSES/Apache-2.0.txt`） |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | sherpa-onnx 自带的推理库 | MIT |
| [edge-tts](https://github.com/rany2/edge-tts) | `voice/edge-tts.js` 移植了它的连接协议与令牌算法 | LGPL-3.0（该文件随之按 LGPL-3.0 授权，见 `LICENSES/`） |

参考过的做法：Windows 上关闭 GPU 进程沙箱以兼容虚拟显示器、绿幕视频转透明动画的流程，来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（代码 MIT）；语音方案的选型参考了 DeepSeek Harness 官方语音插件和 [AAAAGENT](https://github.com/phoiex/AAAAGENT)（未使用其代码）。

## 运行时按需下载、不随程序发布的

| 内容 | 来源 | 许可 |
| --- | --- | --- |
| SenseVoice-Small int8 语音识别模型 | [FunAudioLLM](https://github.com/FunAudioLLM/SenseVoice)，经 sherpa-onnx 转换，从 hf-mirror.com / huggingface.co 下载 | 以 SenseVoice 模型许可为准 |
| Kokoro v1.1 多语言语音合成模型 | [hexgrad/Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)，经 sherpa-onnx 转换 | Apache-2.0 |
| espeak-ng 数据（Kokoro 读英文单词用的一小部分） | [espeak-ng](https://github.com/espeak-ng/espeak-ng) | GPL-3.0 |
| 大肥鱼表情包 GIF | [kiriyuki.com](https://kiriyuki.com) | 见 `assets/LICENSE.md` |

## 网络服务

- **DeepSeek API**（或任何 OpenAI 兼容接口）：聊天、主动说话、看屏幕、碎碎念，使用用户自己的 API Key。
- **Microsoft Edge「大声朗读」在线语音**：非官方接口，要念的文字会发送给微软合成；连不上时自动改用离线语音或系统语音。
