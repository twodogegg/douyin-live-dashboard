import { connectDesktop, desktopStatus, desktopSearch, desktopPlay, desktopControl } from './netease/player.js'

const BUILTIN_TOOLS = {
  netease_player_connect: (args, options) => connectDesktop(args, options),
  netease_now_playing: (_args, options) => desktopStatus(options),
  netease_player_search: ({ query }, options) => desktopSearch(query, options),
  netease_play_song: (args, options) => desktopPlay(args, options),
  netease_player_control: ({ action }, options) => desktopControl(action, options),
}

// 保留 MCP 工具调用接口，直接执行随应用分发的本地工具。
export function createMusicMcp({ tools = BUILTIN_TOOLS } = {}) {
  const controller = new AbortController()
  let serial = Promise.resolve()
  return {
    call(name, args = {}) {
      const operation = serial.then(() => {
        controller.signal.throwIfAborted()
        if (!Object.hasOwn(tools, name) || typeof tools[name] !== 'function') throw new Error('未知的网易云工具')
        return tools[name](args, { signal: controller.signal })
      })
      serial = operation.catch(() => {})
      return operation
    },
    close() { controller.abort(new Error('网易云连接已关闭')) },
  }
}
