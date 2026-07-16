import assert from 'node:assert/strict'
import { access, chmod, cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertCanonicalLayout, generateProviders } from '../scripts/generate-providers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const canonical = path.join(root, 'deyo')

test('provider generation removes stale artifacts and normalizes JSON modes', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'deyo-provider-output-'))
  try {
    await mkdir(path.join(output, '.agents', 'stale'), { recursive: true })
    await writeFile(path.join(output, '.agents', 'stale', 'junk.json'), '{}\n')
    await writeFile(path.join(output, 'gemini-extension.json'), '{"stale":true}\n')
    await chmod(path.join(output, 'gemini-extension.json'), 0o600)

    const generated = await generateProviders(output)
    assert.match(generated.canonicalTreeHash, /^[a-f0-9]{64}$/)
    await assert.rejects(access(path.join(output, '.agents', 'stale', 'junk.json')), { code: 'ENOENT' })
    assert.equal((await stat(path.join(output, 'gemini-extension.json'))).mode & 0o777, 0o644)
    assert.equal((await stat(path.join(output, 'providers', 'metadata.json'))).mode & 0o777, 0o644)

    const metadata = JSON.parse(await readFile(path.join(output, 'providers', 'metadata.json'), 'utf8'))
    assert.equal(metadata.canonicalTreeHash, generated.canonicalTreeHash)
    assert.equal(metadata.providers.openclaw.license, 'MIT-0')
  }
  finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('canonical layout rejects extra files and symlinks', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-canonical-layout-'))
  const copy = path.join(temporary, 'deyo')
  try {
    await cp(canonical, copy, { recursive: true, dereference: false, preserveTimestamps: false })
    await writeFile(path.join(copy, '.DS_Store'), 'junk')
    await assert.rejects(assertCanonicalLayout(copy), /Unexpected canonical Deyo entry: \.DS_Store/)
    await rm(path.join(copy, '.DS_Store'))
    await symlink('SKILL.md', path.join(copy, 'SKILL-link.md'))
    await assert.rejects(assertCanonicalLayout(copy), /Unexpected canonical Deyo entry: SKILL-link\.md \(symlink\)/)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
