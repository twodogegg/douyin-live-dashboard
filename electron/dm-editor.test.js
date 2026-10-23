import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setEditorText } from './dm-editor.js'

test('多段文字写入原生编辑器状态，保留中间空行并兼容末尾自动换行', () => {
  let value = ''
  const editor = { setText: text => { value = text + '\n' }, getText: () => value, flushInput: () => {} }
  const text = '第一段\n\n第二段\n\n第三段'
  assert.equal(setEditorText(editor, text), true)
  assert.equal(value, text + '\n')
})

test('可见 DOM 改了但编辑器状态只有首段时，不允许继续发送', () => {
  const editor = { setText: () => {}, getText: () => '第一段\n' }
  assert.equal(setEditorText(editor, '第一段\n\n第二段'), false)
  assert.equal(setEditorText({}, '第一段'), false)
})
