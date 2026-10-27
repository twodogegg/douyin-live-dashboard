# 抖音直播看板

一个面向抖音直播的本地工作台，提供直播消息查看、AI 互动摘要、私信工作台和直播背景板。项目包含 Electron 桌面版，以及 React 前端搭配 Python 后端的网页开发模式。

![直播背景板界面](docs/images/live-stage.png)

## 功能

- 连接直播间，实时查看主播侧和观众侧消息。
- 使用配置的 AI 模型分析直播互动，生成增量摘要。
- 查看历史记录，在私信工作台处理会话和回复。
- 在桌面版使用直播背景板、AI 回复和 Fish Audio 语音播报，配合直播伴侣采集画面与声音。详细操作见 [直播背景板说明](LIVE-STAGE.md)。
- 在 macOS 桌面版通过网易云客户端自动接收观众点歌、选择版本并按队列播放；所需工具代码已内置在本仓库。
- 管理抖音登录状态、模型配置及相关本地数据。

## 环境要求

- 本地开发需要 Node.js 24 和 npm；安装桌面应用后无需另装 Node.js。
- 桌面开发需要可运行 Electron 的 macOS 或 Windows 环境。
- 网页开发模式还需要 Python 3.10、Google Chrome、FastAPI、Uvicorn 和 Playwright。
- AI 摘要和回复需要自行配置模型服务；语音播报需要 Fish Audio 配置。
- 网易云点歌目前仅支持 macOS，需安装并登录官方网易云客户端；不需要另行安装 MCP 服务或配置其他仓库。

## 开始使用

安装 Node.js 依赖：

```bash
npm ci
```

启动桌面开发版：

```bash
npm run dev:desktop
```

在应用中登录抖音账号，输入直播间号并连接；在「模型与设置」中配置模型服务后，即可使用 AI 分析。直播背景板的播出窗口和音频设置请参照 [LIVE-STAGE.md](LIVE-STAGE.md)。

### 网页开发模式

先为 Python 3.10 安装依赖，并确保本机已安装 Google Chrome：

```bash
python3.10 -m pip install fastapi uvicorn playwright
npm run dev
```

打开 <http://localhost:18731>。Vite 前端默认使用 18731 端口，Python API 使用 18732 端口。也可以分别运行 `npm run dev:web` 和 `npm run dev:api`。

网页模式与桌面版的后端实现不同；直播背景板的 AI 直播回复和 Fish Audio 接口需要 Electron 桌面版。

## 网易云点歌

点歌目前支持 **macOS 桌面版**，通过官方网易云客户端播放音乐。所需工具已内置在本仓库，无需安装独立 MCP、配置 Claude 或下载其他仓库。

### 首次设置与本地测试

1. 安装官方网易云音乐到 `/Applications/NeteaseMusic.app`，打开并登录自己的账号。能否播放完整歌曲取决于账号权限和歌曲版权。
2. 启动本应用，在「模型与设置」中配置支持工具调用（Function Calling）的 AI 模型。
3. 进入「直播背景板」，在右侧「网易云音乐」中点击「连接网易云」。首次连接可能重新打开网易云客户端。
4. 勾选「观众点歌」，点击「开启互动」。仅测试音乐时可以关闭「语音回复」，无需配置 Fish Audio。
5. 在「点播歌曲」中输入歌名和可选歌手，点击「加入点歌队列」，例如 `Pour Elise Richard Clayderman`。本地测试无需开直播或连接直播间。
6. 再加入一首歌曲，检查右上角的当前歌曲、歌手和「下一首」。可用「播放下一首」立即切换，用「暂停音乐／播放音乐」控制播放。网易云已有音乐在播放时，新点的歌曲会先排队；歌曲结束后自动播放队列中的下一首。

### 直播时观众如何点歌

连接正在直播的抖音直播间，保持「观众点歌」和「互动」开启。观众发送弹幕即可，例如：

```text
点歌 稻香
想听周杰伦的晴天
放一首致爱丽丝
```

模型会识别点歌意图，搜索歌曲并自动选择最匹配的版本，无需观众操作候选列表；明确指定歌手时按指定歌手匹配。未指定歌手时优先判断原唱和正式录音室版本，搜索结果没有原唱时可选择合适的翻唱；实际选中的歌名和歌手会显示在点歌台中。

点歌按顺序处理，最多保留 20 条待处理或待播请求，同一首待播歌曲不会重复加入。暂停互动、关闭点歌、切换直播间或重启应用会清空队列；暂停音乐使用单独的播放控制按钮。歌曲无法播放时会显示原因并保留待播歌曲，可点击「播放下一首」重试。

音乐沿用网易云客户端的系统音频输出。正式开播时，在直播伴侣中采集对应的系统／应用音频；主播语音的虚拟声卡设置见 [直播背景板说明](LIVE-STAGE.md)。

### 调整点歌提示词

点歌识别和版本选择的提示词保存在独立配置中。默认模板为 [default-music-agent.json](electron/default-music-agent.json)，首次启动会复制到 Electron 用户数据目录中的 `music_agent.json`：macOS 默认位于 `~/Library/Application Support/抖音直播看板/music_agent.json`。

修改运行时文件里的 `recognize`（点歌识别）、`select`（版本选择）或 `host_context`（主播引用点歌状态），下一次调用即可生效，无需修改代码或重新构建。

## 构建与验证

```bash
npm run build                 # TypeScript 检查并构建前端
npm run desktop               # 构建前端并启动 Electron
npm run desktop:build:mac     # 构建 macOS 安装包
npm run desktop:build:win     # 构建 Windows 安装包
```

前端构建产物位于 `dist/`，桌面安装包位于 `release/`。Electron 模块包含使用 Node.js 内置测试运行器的测试，可按需运行，例如：

```bash
node --test electron/live-stage.test.js electron/fish.test.js electron/stage-audio.test.js
```

涉及直播连接、登录和播出流程的改动，还需要在桌面版中进行实际操作验证。

## 项目结构

```text
src/                    React 前端、组件、WebSocket hooks 和样式
electron/               桌面应用、服务、数据库、直播及私信逻辑
public/                 前端静态资源
live_server.py          Python 网页模式 API 服务
douyin_live_scraper.py  基于 Playwright 的直播采集
douyin_live_ai.py       Python 直播分析逻辑
agent_config.py         Python 分析配置管理
```

## 数据与配置

桌面版将数据库、模型配置、生成图片和音频等运行数据保存在 Electron 的用户数据目录；Python 模式使用项目根目录下的配置及本地数据文件。登录状态、API 密钥、数据库和采集日志可能包含敏感信息，请勿提交到版本库。使用 AI 或语音服务时，相关内容会发送给所配置的服务提供商。

## 第三方代码

网易云桌面工具及歌曲元数据适配包含改编自 netease-music-mcp 的代码，采用 MIT 许可。来源和版权声明见 [内置网易云工具说明](electron/netease/README.md)及其 [LICENSE](electron/netease/LICENSE)。
