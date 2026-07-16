#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { assertStableSemver, hashTree, validateReleaseNotes } from './release-core.mjs'
import { checkProviders } from './generate-providers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function validateSkillFrontmatter(relativePath) {
  const content = await readFile(path.join(root, relativePath), 'utf8')
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  assert(match, `${relativePath} must start with YAML frontmatter`)
  const frontmatter = parseYaml(match[1])
  assert(frontmatter && typeof frontmatter === 'object', `${relativePath} frontmatter must be an object`)
  assert(Object.keys(frontmatter).sort().join(',') === 'description,name', `${relativePath} frontmatter may contain only name and description`)
  assert(frontmatter.name === 'deyo', `${relativePath} frontmatter name must be deyo`)
  assert(typeof frontmatter.description === 'string' && frontmatter.description.length > 40, `${relativePath} description is invalid`)
  assert(!/^\s*version:/m.test(match[1]), `${relativePath} frontmatter must not contain version`)
}

async function validateYaml(relativePath) {
  const value = parseYaml(await readFile(path.join(root, relativePath), 'utf8'))
  assert(value && typeof value === 'object', `${relativePath} must contain YAML metadata`)
  return value
}

function assertVersion(value, expected, label) {
  assertStableSemver(value, label)
  assert(value === expected, `${label} ${value} does not match canonical ${expected}`)
}

async function validatePluginSkill(relativePath, canonicalHash) {
  assert(await hashTree(path.join(root, relativePath)) === canonicalHash, `${relativePath} does not match canonical deyo tree`)
}

export async function validateArtifacts() {
  await checkProviders()
  validateReleaseNotes(await readFile(path.join(root, 'release/next.md')))
  const canonical = await readJson('deyo/manifest.json')
  const version = canonical.skillVersion
  assertVersion(version, version, 'canonical Skill version')
  assertStableSemver(canonical.minimumCliVersion, 'minimum CLI version')
  assert(canonical.minimumCliVersion === '0.2.1', 'fix-forward Skill minimum CLI version must be 0.2.1')

  await validateSkillFrontmatter('deyo/SKILL.md')
  const canonicalSkill = await readFile(path.join(root, 'deyo/SKILL.md'), 'utf8')
  assert(!/--language zh\b/.test(canonicalSkill), 'canonical Skill must not hardcode --language zh')
  assert(/automatic language detection/.test(canonicalSkill), 'canonical Skill must explain automatic language detection')
  assert(/Explicit Authorization Boundary/.test(canonicalSkill), 'canonical Skill must define an explicit authorization boundary')
  const [openaiAgent, claudeAgent] = await Promise.all([
    validateYaml('deyo/agents/openai.yaml'),
    validateYaml('deyo/agents/claude.yaml'),
    validateYaml('deyo/agents/gemini.yaml'),
  ])
  assert(openaiAgent.policy?.allow_implicit_invocation === false, 'OpenAI implicit invocation must be disabled')
  assert(claudeAgent.claude_code?.invocation?.implicit === false, 'Claude implicit invocation must be disabled')
  assert(claudeAgent.policy?.allow_implicit_invocation === false, 'Claude implicit invocation policy must be disabled')

  const [codex, claude, gemini, metadata, codexMarketplace, claudeMarketplace] = await Promise.all([
    readJson('plugins/deyo/.codex-plugin/plugin.json'),
    readJson('plugins/deyo/.claude-plugin/plugin.json'),
    readJson('gemini-extension.json'),
    readJson('providers/metadata.json'),
    readJson('.agents/plugins/marketplace.json'),
    readJson('.claude-plugin/marketplace.json'),
  ])

  assertVersion(codex.version, version, 'Codex plugin version')
  assertVersion(claude.version, version, 'Claude plugin version')
  assertVersion(gemini.version, version, 'Gemini extension version')
  assertVersion(metadata.skillVersion, version, 'provider metadata version')
  assert(metadata.minimumCliVersion === canonical.minimumCliVersion, 'provider minimum CLI version mismatch')

  assert(codex.name === 'deyo' && claude.name === 'deyo' && gemini.name === 'deyo', 'provider name mismatch')
  assert(codex.skills === './skills/' && claude.skills === './skills/', 'plugin skill paths must remain self-contained')
  assert(codex.license === 'UNLICENSED' && claude.license === 'UNLICENSED', 'non-ClawHub provider license changed')
  assert(codex.repository === 'https://github.com/casatwy/deyo-skill', 'Codex repository mismatch')
  assert(claude.repository === 'https://github.com/casatwy/deyo-skill', 'Claude repository mismatch')

  assert(codexMarketplace.name === 'deyo-official', 'Codex marketplace must be deyo-official')
  assert(codexMarketplace.plugins?.length === 1, 'Codex marketplace must contain exactly one plugin')
  const codexEntry = codexMarketplace.plugins[0]
  assert(codexEntry.name === 'deyo', 'Codex plugin must be deyo')
  assert(codexEntry.source?.source === 'local' && codexEntry.source?.path === './plugins/deyo', 'Codex plugin source mismatch')
  assert(codexEntry.policy?.installation === 'AVAILABLE', 'Codex install policy mismatch')
  assert(codexEntry.policy?.authentication === 'ON_INSTALL', 'Codex auth policy mismatch')
  assert(typeof codexEntry.category === 'string' && codexEntry.category.length > 0, 'Codex category is required')

  assert(claudeMarketplace.name === 'deyo-official', 'Claude marketplace must be deyo-official')
  assert(claudeMarketplace.plugins?.length === 1, 'Claude marketplace must contain exactly one plugin')
  assert(claudeMarketplace.plugins[0].name === 'deyo', 'Claude plugin must be deyo')
  assert(claudeMarketplace.plugins[0].source === './plugins/deyo', 'Claude plugin source mismatch')

  const canonicalHash = await hashTree(path.join(root, 'deyo'))
  assert(metadata.canonicalTreeHash === canonicalHash, 'canonical tree hash metadata is stale')
  assert(metadata.source?.repository === 'https://github.com/casatwy/deyo-skill.git', 'provider source repository mismatch')
  assert(metadata.source?.ref === `v${version}`, 'provider source ref mismatch')
  assert(metadata.providers?.codex?.marketplace === 'deyo-official', 'Codex metadata marketplace mismatch')
  assert(metadata.providers?.codex?.plugin === 'deyo@deyo-official', 'Codex metadata plugin mismatch')
  assert(metadata.providers?.claude?.plugin === 'deyo@deyo-official', 'Claude metadata plugin mismatch')
  assert(metadata.providers?.openclaw?.registry === '@casatwy/deyo', 'OpenClaw registry mismatch')
  assert(metadata.providers?.openclaw?.license === 'MIT-0', 'OpenClaw/ClawHub license must be MIT-0')
  assert(metadata.providers?.openclaw?.artifactProjection === 'openclaw-v1', 'OpenClaw projection metadata mismatch')
  assert(metadata.providers?.openclaw?.projectionSince === '1.0.10', 'OpenClaw projection version mismatch')
  assert(JSON.stringify(metadata.providers?.openclaw?.excludedPaths) === JSON.stringify(['agents/**']), 'OpenClaw excluded paths mismatch')
  assert(metadata.providers?.openclaw?.userInvocable === true, 'OpenClaw must be user-invocable')
  assert(metadata.providers?.openclaw?.disableModelInvocation === true, 'OpenClaw model invocation must be disabled')
  await validatePluginSkill('plugins/deyo/skills/deyo', canonicalHash)
  await validatePluginSkill('skills/deyo', canonicalHash)

  await Promise.all([
    access(path.join(root, 'deyo/scripts/publish-cleaned.mjs')),
    access(path.join(root, 'deyo/scripts/openclaw-auto-update.mjs')),
    access(path.join(root, 'release/next.md')),
  ])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateArtifacts()
  process.stdout.write('Deyo Skill artifacts are valid and in parity.\n')
}
