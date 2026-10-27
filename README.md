# 抖音直播看板

一个面向抖音直播的本地工作台，提供直播消息查看、AI 互动摘要、私信工作台和直播背景板。项目包含 Electron 桌面版，以及 React 前端搭配 Python 后端的网页开发模式。

![直播背景板界面](docs/images/live-stage.png)

## 功能

- 连接直播间，实时查看主播侧和观众侧消息。
- 使用配置的 AI 模型分析直播互动，生成增量摘要。
- 查看历史记录，在私信工作台处理会话和回复。
- 在桌面版使用直播背景板、AI 回复和 Fish Audio 语音播报，配合直播伴侣采集画面与声音。详细操作见 [直播背景板说明](LIVE-STAGE.md)。
- 管理抖音登录状态、模型配置及相关本地数据。

## 环境要求

- Node.js 24 和 npm。
- 桌面开发需要可运行 Electron 的 macOS 或 Windows 环境。
- 网页开发模式还需要 Python 3.10、Google Chrome、FastAPI、Uvicorn 和 Playwright。
- AI 摘要和回复需要自行配置模型服务；语音播报需要 Fish Audio 配置。

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
