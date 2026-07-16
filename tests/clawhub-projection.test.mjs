import assert from 'node:assert/strict'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  addOpenClawInvocationFrontmatter,
  projectClawHubSkill,
  usesOpenClawProjection,
} from '../scripts/clawhub-projection.mjs'
import { hashTree } from '../scripts/release-core.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const canonical = path.join(root, 'deyo')

async function stageVersion(version) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-clawhub-projection-test-'))
  const source = path.join(temporary, 'canonical')
  const output = path.join(temporary, 'projected')
  await cp(canonical, source, { recursive: true, dereference: false, preserveTimestamps: false })
  const manifestPath = path.join(source, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.skillVersion = version
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { temporary, source, output }
}

test('OpenClaw invocation frontmatter is projection-only and exact', () => {
  const canonicalSkill = '---\nname: deyo\ndescription: explicit only\n---\n\n# Deyo\n'
  const projected = addOpenClawInvocationFrontmatter(canonicalSkill)
  const match = projected.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match)
  assert.deepEqual(parseYaml(match[1]), {
    name: 'deyo',
    description: 'explicit only',
    'user-invocable': true,
    'disable-model-invocation': true,
  })
  assert.throws(() => addOpenClawInvocationFrontmatter(projected), /projection/)
})

test('1.0.9 keeps the immutable legacy full artifact for fix-forward evidence', async () => {
  const fixture = await stageVersion('1.0.9')
  try {
    assert.equal(usesOpenClawProjection('1.0.9'), false)
    const projection = await projectClawHubSkill(fixture.source, fixture.output)
    assert.equal(projection.kind, 'legacy-full')
    assert.equal(projection.canonicalTreeHash, await hashTree(fixture.source))
    assert.equal(projection.projectionTreeHash, projection.canonicalTreeHash)
    await access(path.join(fixture.output, 'agents', 'openai.yaml'))
  }
  finally {
    await rm(fixture.temporary, { recursive: true, force: true })
  }
})

test('1.0.10+ projection excludes provider agents and requires explicit slash invocation', async () => {
  const fixture = await stageVersion('1.0.10')
  try {
    assert.equal(usesOpenClawProjection('1.0.10'), true)
    const canonicalHashBefore = await hashTree(fixture.source)
    const projection = await projectClawHubSkill(fixture.source, fixture.output)
    assert.equal(projection.kind, 'openclaw-v1')
    assert.equal(projection.canonicalTreeHash, canonicalHashBefore)
    assert.notEqual(projection.projectionTreeHash, projection.canonicalTreeHash)
    await assert.rejects(access(path.join(fixture.output, 'agents')), { code: 'ENOENT' })

    const skill = await readFile(path.join(fixture.output, 'SKILL.md'), 'utf8')
    const match = skill.match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(match)
    const frontmatter = parseYaml(match[1])
    assert.equal(frontmatter['user-invocable'], true)
    assert.equal(frontmatter['disable-model-invocation'], true)
    assert.doesNotMatch(skill, /--language zh\b/)

    assert.equal(await hashTree(fixture.source), canonicalHashBefore, 'projection must not mutate tag canonical content')
    await access(path.join(fixture.source, 'agents', 'openai.yaml'))
  }
  finally {
    await rm(fixture.temporary, { recursive: true, force: true })
  }
})
