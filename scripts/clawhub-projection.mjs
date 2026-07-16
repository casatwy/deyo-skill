import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compareSemver, hashTree } from './release-core.mjs'

export const OPENCLAW_PROJECTION_SINCE = '1.0.10'

export function usesOpenClawProjection(version) {
  return compareSemver(version, OPENCLAW_PROJECTION_SINCE) >= 0
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
  if (projected) {
    await rm(path.join(outputDirectory, 'agents'), { recursive: true, force: true })
    const skillPath = path.join(outputDirectory, 'SKILL.md')
    const skill = await readFile(skillPath, 'utf8')
    await writeFile(skillPath, addOpenClawInvocationFrontmatter(skill))
  }

  return {
    skillVersion: manifest.skillVersion,
    kind: projected ? 'openclaw-v1' : 'legacy-full',
    canonicalTreeHash,
    projectionTreeHash: await hashTree(outputDirectory),
  }
}
