import { TOOL_DEFINITIONS } from './capabilities.js'

// 通用 OpenAI-compatible function-calling 循环。工具由 Agent 白名单决定，
// 与 darl-ui 的 execute/maxSteps 分层一致，模型不会收到未勾选的工具。
export async function runAgent({ messages, config, request, execute, maxSteps = 6, agents = [] }) {
  const tools = TOOL_DEFINITIONS.filter(tool => config.tools.includes(tool.id) && (!agents.length || tool.agents.some(agent => agents.includes(agent))))
  const history = [...messages]
  const calls = []
  for (let step = 0; step < (tools.length ? maxSteps : 1); step++) {
    const response = await request(history, tools.map(tool => tool.definition))
    const message = response.choices?.[0]?.message
    if (!message || typeof message !== 'object') throw new Error('模型没有返回有效消息')
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      if (typeof message.content !== 'string') throw new Error('模型没有返回回复正文')
      return { text: message.content.trim(), calls, messages: history }
    }
    history.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: message.tool_calls })
    if (message.tool_calls.length > 8) throw new Error('单轮工具调用过多，请缩小任务后重试')
    for (const call of message.tool_calls) {
      if (typeof call?.id !== 'string' || call.type !== 'function' || !config.tools.includes(call.function?.name)) throw new Error('模型调用了未授权的工具')
      let args
      try { args = JSON.parse(call.function.arguments || '{}') } catch { throw new Error('工具参数不是有效 JSON') }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象')
      const output = await execute(call.function.name, args)
      const record = { id: call.id, name: call.function.name, args, ...output }
      calls.push(record)
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
    }
  }
  throw new Error('工具调用次数已达到上限，请缩小任务后重试')
}
