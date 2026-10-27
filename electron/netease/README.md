# 内置网易云桌面工具

本目录随桌面应用一起打包，不依赖任何其他仓库、Claude 配置、全局 MCP 服务或外部 Node.js 可执行文件。

- `player.js`：通过本机官方网易云客户端的 CEF 页面搜索、播放、读取状态和控制播放。
- `song-details.js`：只读获取歌曲名称、歌手、专辑和时长，不读取 Cookie 或获取音频下载地址。
- 上层 `../music-mcp.js` 保留现有网易云 MCP 工具名称和 `call` 接口，工具在应用进程内执行。

仅支持 macOS，需单独安装官方网易云客户端，默认位置为 `/Applications/NeteaseMusic.app`。连接后调试端口仅监听 `127.0.0.1:19263`。已验证客户端版本为 3.1.14；页面结构改变可能需要更新适配。

`player.js` 来自本功能开发时的桌面扩展，`song-details.js` 的接口及字段映射改编自 [netease-music-mcp](https://github.com/tianyupaipai-cmd/netease-music-mcp) v0.7.0 的 `src/netease.js`。保留上游 MIT 许可和版权声明于 [LICENSE](LICENSE)。未复制上游账号会话、凭证、缓存或运行时配置。
