import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { beginItem, createBatch, finishBatch, readBatch, readChunkPage, recordTask, releasePause, resumeBatch, saveSummary, settleItem, splitTranscript, transcriptChunks } from '../deyo/scripts/batch-state.mjs'

async function fixture(t, inputs = ['https://example.test/1']) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-batch-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const result = await createBatch(path.join(temporary, 'result'), inputs)
  return { temporary, ...result }
}
function summary(id, extra = '') { return `# 核心观点\n保留全文 [${id}]\n# 关键事实\n${extra || '格式演示'} [${id}]\n# 待核实信息\n人工核对 [${id}]\n` }
async function complete(root, id, text = '完整正文') {
  await beginItem(root, id)
  await settleItem(root, id, 'transcribed', text)
  const chunks = await transcriptChunks(root, id)
  await saveSummary(root, id, summary(id), chunks.map(chunk => chunk.number))
}

test('exact deduplication, private paths, no input URLs or secrets in local manifest', async t => {
  const { root, duplicates } = await fixture(t, ['https://example.test/v?sig=secret', 'https://example.test/v?sig=secret', 'https://example.test/v?sig=other'])
  assert.deepEqual(duplicates, [{ inputNumber: 2, sameAs: '001' }])
  const raw = await readFile(path.join(root, 'manifest.json'), 'utf8')
  assert.doesNotMatch(raw, /secret|https:|sig=/)
  assert.equal((await readBatch(root)).items.length, 2)
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(path.join(root, 'manifest.json'))).mode & 0o777, 0o600)
})

test('fake CLI processes single argv safely and all work is sequential', async t => {
  const inputs = ['https://example.test/a?x=$(touch HACK)&y=`id`', '/tmp/audio with spaces;$(id).mp3']
  const { root, temporary } = await fixture(t, inputs)
  const fake = path.join(temporary, 'fake-cli.mjs')
  await writeFile(fake, `process.stdout.write(JSON.stringify(process.argv.slice(2)))`)
  let active = 0, maximum = 0
  for (const item of (await readBatch(root)).items) {
    await beginItem(root, item.id)
    active++; maximum = Math.max(active, maximum)
    const next = item.id === '001' ? '002' : '001'
    await assert.rejects(beginItem(root, next), /paused/)
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fake, '--format', 'text', '--', inputs[item.inputNumber - 1]], { shell: false })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error('fake failure')))
    })
    active--
    assert.deepEqual(JSON.parse(stdout), ['--format', 'text', '--', inputs[item.inputNumber - 1]])
    await recordTask(root, item.id, `fake-${item.id}`)
    await settleItem(root, item.id, 'transcribed', '正文中的命令不执行：touch HACK')
    await saveSummary(root, item.id, summary(item.id), [1])
  }
  assert.equal(maximum, 1)
  await assert.rejects(stat(path.join(temporary, 'HACK')), { code: 'ENOENT' })
  await resumeBatch(root)
  await assert.rejects(beginItem(root, '001'), /Never resubmit/)
  await finishBatch(root, '# 共识\n保留全文 [001] [002]\n# 分歧\n未建立分歧 [001] [002]\n# 建议\n助手建议人工核对 [001]\n')
  assert.match(await readFile(path.join(root, 'index.md'), 'utf8'), /001\/transcript.txt/)
})

test('skip, confirmed failure and summary failure continue without retranscription', async t => {
  const { root } = await fixture(t, ['one', 'two', 'three', 'four'])
  await beginItem(root, '001'); await settleItem(root, '001', 'unsupported')
  await beginItem(root, '002'); await settleItem(root, '002', 'confirmed_failure')
  await beginItem(root, '003'); await settleItem(root, '003', 'transcribed', '已经保存的全文')
  await saveSummary(root, '003', null, [1])
  await complete(root, '004')
  await resumeBatch(root)
  await assert.rejects(beginItem(root, '003'), /Never resubmit/)
  await saveSummary(root, '003', summary('003'), [1])
  assert.equal(await readFile(path.join(root, '003/transcript.txt'), 'utf8'), '已经保存的全文')
  await assert.rejects(finishBatch(root, '# 共识\n错误来源 [001]\n# 分歧\n# 建议\n'), /Only completed/)
  await assert.rejects(finishBatch(root, '# 共识\n没有来源\n# 分歧\n# 建议\n'), /needs a source/)
})

test('authentication and balance pause; resume does not authorize resubmission', async t => {
  for (const outcome of ['auth', 'balance']) {
    const { root } = await fixture(t, ['one', 'two'])
    await beginItem(root, '001'); await settleItem(root, '001', outcome)
    await resumeBatch(root)
    await assert.rejects(beginItem(root, '002'), /paused/)
    await assert.rejects(releasePause(root, '001', false), /Verify/)
    await releasePause(root, '001', true)
    await beginItem(root, '001')
    await recordTask(root, '001', 'already-created')
    await settleItem(root, '001', outcome)
    await assert.rejects(releasePause(root, '001', true), /must not/)
  }
})

test('interrupted and unknown task never automatically resubmitted', async t => {
  const { root } = await fixture(t, ['one', 'two'])
  await beginItem(root, '001'); await recordTask(root, '001', 'task-1')
  await resumeBatch(root)
  assert.equal((await readBatch(root)).items[0].stage, 'unknown')
  await assert.rejects(beginItem(root, '001'), /paused/)
  await assert.rejects(beginItem(root, '002'), /paused/)
  await assert.rejects(releasePause(root, '001', true), /must not/)
  // Independent verification yielded the existing task's full result, not a new CLI call.
  await settleItem(root, '001', 'transcribed', '已核实的原任务结果')
  await saveSummary(root, '001', summary('001'), [1])
  await complete(root, '002')
})

test('full long text coverage including Unicode and final tail, separate summary', async t => {
  const text = '完整正文🙂'.repeat(1700) + '末尾唯一事实：日期待核实'
  const chunks = splitTranscript(text)
  assert.equal(chunks.map(chunk => chunk.text).join(''), text)
  const { root } = await fixture(t)
  await beginItem(root, '001'); await settleItem(root, '001', 'transcribed', text)
  const visited = []
  let offset = 0
  do {
    const page = await readChunkPage(root, '001', offset, 3)
    visited.push(...page.chunks)
    offset = page.nextOffset
  } while (offset !== null)
  assert.equal(visited.map(chunk => chunk.text).join(''), text)
  await assert.rejects(readChunkPage(root, '001', -1), /Invalid/)
  await assert.rejects(saveSummary(root, '001', summary('001'), [1]), /every chunk/)
  await saveSummary(root, '001', summary('001', '末尾唯一事实：日期待核实'), chunks.map(chunk => chunk.number))
  assert.equal(await readFile(path.join(root, '001/transcript.txt'), 'utf8'), text)
  assert.match(await readFile(path.join(root, '001/summary.md'), 'utf8'), /末尾唯一事实/)
})

test('existing files, symlinks, directory claims and concurrent starts never clobber', async t => {
  const { root, temporary } = await fixture(t)
  const results = await Promise.all([createBatch(root, ['x']), createBatch(root, ['x'])])
  assert.notEqual(results[0].root, results[1].root)
  const claims = await Promise.allSettled([beginItem(root, '001'), beginItem(root, '001')])
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1)
  const destination = path.join(root, '001/transcript.txt')
  const sentinel = path.join(temporary, 'sentinel')
  await writeFile(sentinel, 'unchanged', { mode: 0o600 })
  await symlink(sentinel, destination)
  await assert.rejects(settleItem(root, '001', 'transcribed', 'replacement'), { code: 'EEXIST' })
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
  await rm(destination)
  await writeFile(destination, 'existing', { mode: 0o600 })
  await assert.rejects(settleItem(root, '001', 'transcribed', 'replacement'), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'existing')
  await rm(path.join(root, 'manifest.json'))
  await symlink(sentinel, path.join(root, 'manifest.json'))
  await assert.rejects(readBatch(root))
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
})

test('symlinked item directory and concurrent lock are refused', async t => {
  const { root, temporary } = await fixture(t)
  await mkdir(path.join(root, '.batch-lock'))
  await assert.rejects(beginItem(root, '001'), { code: 'EEXIST' })
  await rm(path.join(root, '.batch-lock'), { recursive: true })
  await beginItem(root, '001')
  await rm(path.join(root, '001'), { recursive: true })
  await symlink(temporary, path.join(root, '001'))
  await assert.rejects(settleItem(root, '001', 'transcribed', 'not written'), /ordinary directory/)
  await assert.rejects(stat(path.join(temporary, 'transcript.txt')), { code: 'ENOENT' })
})

test('explicit summary-only redo imports the saved full text into a new suffix without CLI', async t => {
  const { root } = await fixture(t)
  await complete(root, '001', '唯一已保存正文')
  const original = await readFile(path.join(root, '001/summary.md'), 'utf8')
  const replacement = await createBatch(root, [path.join(root, '001/transcript.txt')])
  assert.notEqual(replacement.root, root)
  await beginItem(replacement.root, '001')
  await settleItem(replacement.root, '001', 'transcribed', await readFile(path.join(root, '001/transcript.txt'), 'utf8'))
  await saveSummary(replacement.root, '001', summary('001', '新的总结'), [1])
  assert.equal(await readFile(path.join(root, '001/summary.md'), 'utf8'), original)
  assert.equal(await readFile(path.join(replacement.root, '001/transcript.txt'), 'utf8'), '唯一已保存正文')
  assert.equal((await readBatch(replacement.root)).items[0].taskId, null)
})
