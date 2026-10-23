// 使用原生编辑器 API，让可见内容和发送时读取的编辑器状态保持一致。
export function setEditorText(editor, text) {
  if (typeof editor?.setText !== 'function' || typeof editor?.getText !== 'function') return false
  editor.setText(text)
  editor.flushInput?.()
  const normalize = value => String(value || '').replace(/\r\n/g, '\n').trimEnd()
  return normalize(editor.getText()) === normalize(text)
}
