import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compareSemver, hashTree } from './release-core.mjs'

export const OPENCLAW_PROJECTION_SINCE = '1.0.10'
export const OPENCLAW_V2_PROJECTION_SINCE = '1.0.11'

export function usesOpenClawProjection(version) {
  return compareSemver(version, OPENCLAW_PROJECTION_SINCE) >= 0
}

export function usesOpenClawV2Projection(version) {
  return compareSemver(version, OPENCLAW_V2_PROJECTION_SINCE) >= 0
}

export function addOpenClawInvocationFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error('ClawHub projection requires SKILL.md YAML frontmatter')
  if (/^(?:user-invocable|disable-model-invocation):/m.test(match[1])) {
    throw new Error('OpenClaw invocation fields belong only in the ClawHub projection')
  }
  const projectedFrontmatter = [
    match[1],
    'user-invocable: true',
    'disable-model-invocation: true',
  ].join('\n')
  return content.replace(match[0], `---\n${projectedFrontmatter}\n---\n`)
}

export function addOpenClawV2Frontmatter(content) {
  const invoked = addOpenClawInvocationFrontmatter(content)
  const match = invoked.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error('ClawHub projection requires SKILL.md YAML frontmatter')
  if (/^metadata:/m.test(match[1])) {
    throw new Error('OpenClaw metadata belongs only in the ClawHub projection')
  }
  const projectedFrontmatter = [
    match[1],
    'metadata:',
    '  openclaw:',
    '    requires:',
    '      bins:',
    '        - deyo',
    '        - openclaw',
  ].join('\n')
  return invoked.replace(match[0], `---\n${projectedFrontmatter}\n---\n`)
}

export async function projectClawHubSkill(canonicalDirectory, outputDirectory) {
  const manifest = JSON.parse(await readFile(path.join(canonicalDirectory, 'manifest.json'), 'utf8'))
  const canonicalTreeHash = await hashTree(canonicalDirectory)
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(path.dirname(outputDirectory), { recursive: true })
  await cp(canonicalDirectory, outputDirectory, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
  })

  const projected = usesOpenClawProjection(manifest.skillVersion)
  const projectedV2 = usesOpenClawV2Projection(manifest.skillVersion)
  if (projected) {
    await rm(path.join(outputDirectory, 'agents'), { recursive: true, force: true })
    if (projectedV2) {
      await rm(path.join(outputDirectory, 'scripts/openclaw-auto-update.mjs'), { force: true })
    }
    const skillPath = path.join(outputDirectory, 'SKILL.md')
    const skill = await readFile(skillPath, 'utf8')
    await writeFile(skillPath, projectedV2
      ? addOpenClawV2Frontmatter(skill)
      : addOpenClawInvocationFrontmatter(skill))
  }

  return {
    skillVersion: manifest.skillVersion,
    kind: projectedV2 ? 'openclaw-v2' : projected ? 'openclaw-v1' : 'legacy-full',
    canonicalTreeHash,
    projectionTreeHash: await hashTree(outputDirectory),
  }
}
