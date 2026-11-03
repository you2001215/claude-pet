# 第三方组件与服务

## 随程序一起发布的

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 程序外壳（含 Chromium、Node.js） | MIT（Chromium 各组件许可见安装目录 `LICENSES.chromium.html`） |
| [ws](https://github.com/websockets/ws) | Edge 语音的 WebSocket 连接 | MIT |
| [yaml](https://github.com/eemeli/yaml) | 读取 DeepSeek Harness 配置 | ISC |
| [sherpa-onnx / sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) 1.13.8 | 离线语音合成与识别引擎（打包在安装包的 `resources/sherpa`） | Apache-2.0（见 `LICENSES/Apache-2.0.txt`） |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) 1.28.2 | sherpa-onnx 自带的推理库（`onnxruntime.dll` / `libonnxruntime.dylib`） | MIT，Copyright (c) Microsoft Corporation（见 `LICENSES/ONNXRuntime-MIT.txt`；它包含的第三方代码见 `LICENSES/ONNXRuntime-ThirdPartyNotices.txt`） |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng)（sherpa-onnx 用的分支 [csukuangfj/espeak-ng](https://github.com/csukuangfj/espeak-ng)） | 编译在 sherpa-onnx 的运行库（`sherpa-onnx-c-api`）里，Kokoro 用它给英文单词注音 | GPL-3.0（见 `LICENSES/GPL-3.0.txt`；源代码获取见下文） |
| [piper-phonemize](https://github.com/rhasspy/piper-phonemize)（sherpa-onnx 用的分支 [csukuangfj/piper-phonemize](https://github.com/csukuangfj/piper-phonemize)） | 同样编译在 sherpa-onnx 的运行库里，调用 espeak-ng 注音 | MIT，Copyright (c) 2023 Michael Hansen（见 `LICENSES/piper-phonemize-MIT.txt`） |
| [edge-tts](https://github.com/rany2/edge-tts) | `voice/edge-tts.js` 移植了它的连接协议与令牌算法 | LGPL-3.0（该文件随之按 LGPL-3.0 授权，见 `LICENSES/`） |

sherpa-onnx 的运行库里还编译了 kaldi-native-fbank、kaldi-decoder、simple-sentencepiece 等组件，清单和各自的许可见 sherpa-onnx v1.13.8 源代码的 [`cmake/`](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8/cmake) 目录。

参考过的做法：Windows 上关闭 GPU 进程沙箱以兼容虚拟显示器、绿幕视频转透明动画的流程，来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（代码 MIT）；语音方案的选型参考了 DeepSeek Harness 官方语音插件和 [AAAAGENT](https://github.com/phoiex/AAAAGENT)（未使用其代码）。

### espeak-ng 等 GPL 组件的源代码

安装包里的 sherpa-onnx 运行库是从 npm 上的官方预编译包原样取来的（`sherpa-onnx-node`、`sherpa-onnx-win-x64`、`sherpa-onnx-darwin-arm64`，版本 1.13.8，`scripts/fetch-sherpa.js` 下载时会核对 sha512），本项目没有修改。对应的源代码：

- sherpa-onnx v1.13.8：<https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8>（压缩包：<https://github.com/k2-fsa/sherpa-onnx/archive/refs/tags/v1.13.8.tar.gz>）
- 它编译进去的 espeak-ng，版本是 csukuangfj/espeak-ng 的提交 `ed530aa113046142eb5115cf2fc9157854d0ffe1`：<https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip>（SHA256 `e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd`）。这个版本号写在 sherpa-onnx v1.13.8 的 [`cmake/espeak-ng-for-piper.cmake`](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/espeak-ng-for-piper.cmake) 里。
- 同时编译进去的 piper-phonemize：<https://github.com/csukuangfj/piper-phonemize/archive/f3ff95afc03640bc1399e113e83361192a2fafb4.zip>（见 [`cmake/piper-phonemize.cmake`](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/cmake/piper-phonemize.cmake)）。

书面提供源代码的承诺：如果上面的链接失效，可以在本项目的 GitHub 仓库（<https://github.com/you2001215/claude-pet>）提 issue 索取。自每个版本发布起至少三年内，我们免费提供与该版本安装包里的二进制文件对应的完整源代码。

## 运行时按需下载、不随程序发布的

| 内容 | 来源 | 许可 |
| --- | --- | --- |
| SenseVoice-Small int8 语音识别模型 | [FunAudioLLM](https://github.com/FunAudioLLM/SenseVoice)，经 sherpa-onnx 转换，从 hf-mirror.com / huggingface.co 下载 | 以 SenseVoice 模型许可为准 |
| Kokoro v1.1 多语言语音合成模型 | [hexgrad/Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)，经 sherpa-onnx 转换 | Apache-2.0 |
| espeak-ng 数据（`espeak-ng-data`，随 Kokoro 模型一起下载；程序代码本身随安装包发布，见上表） | [espeak-ng](https://github.com/espeak-ng/espeak-ng) | GPL-3.0 |
| 大肥鱼表情包 GIF | [kiriyuki.com](https://kiriyuki.com) | 见 `assets/LICENSE.md` |

## 网络服务

- **DeepSeek API**（或任何 OpenAI 兼容接口）：聊天、主动说话、看屏幕、碎碎念，使用用户自己的 API Key。
- **Microsoft Edge「大声朗读」在线语音**：非官方接口，默认的朗读方式。要念的文字会发送给微软合成；连不上时自动改用离线语音或系统语音，也可以在设置里直接改用离线语音或系统语音。
