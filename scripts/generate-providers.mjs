#!/usr/bin/env node

import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertStableSemver, describeTree, hashTree } from './release-core.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalDirectory = path.join(root, 'deyo')
const GENERATED_DIRECTORIES = ['.agents', '.claude-plugin', 'plugins', 'providers', 'skills']
const CANONICAL_LAYOUT = new Map([
  ['SKILL.md', 'file'],
  ['agents', 'directory'],
  ['agents/claude.yaml', 'file'],
  ['agents/gemini.yaml', 'file'],
  ['agents/openai.yaml', 'file'],
  ['manifest.json', 'file'],
  ['scripts', 'directory'],
  ['scripts/openclaw-auto-update.mjs', 'file'],
  ['scripts/publish-cleaned.mjs', 'file'],
])

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readManifest(sourceDirectory) {
  const manifest = JSON.parse(await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8'))
  assertStableSemver(manifest.skillVersion, 'canonical skill version')
  assertStableSemver(manifest.minimumCliVersion, 'minimum CLI version')
  if (Object.keys(manifest).sort().join(',') !== 'minimumCliVersion,skillVersion') {
    throw new Error('deyo/manifest.json must contain only skillVersion and minimumCliVersion')
  }
  return manifest
}

async function replaceDirectory(source, target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: false })
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, json(value), { mode: 0o644 })
  await chmod(target, 0o644)
}

export async function assertCanonicalLayout(sourceDirectory = canonicalDirectory) {
  const entries = await describeTree(sourceDirectory)
  const actual = new Map(entries.map(entry => [entry.path, entry.type]))
  for (const entry of entries) {
    const expectedType = CANONICAL_LAYOUT.get(entry.path)
    if (!expectedType || expectedType !== entry.type) {
      throw new Error(`Unexpected canonical Deyo entry: ${entry.path} (${entry.type})`)
    }
  }
  for (const [expectedPath, expectedType] of CANONICAL_LAYOUT) {
    if (actual.get(expectedPath) !== expectedType) {
      throw new Error(`Missing canonical Deyo entry: ${expectedPath} (${expectedType})`)
    }
  }
}

export async function generateProviders(outputRoot = root, sourceDirectory = canonicalDirectory) {
  await assertCanonicalLayout(sourceDirectory)
  const manifest = await readManifest(sourceDirectory)
  const version = manifest.skillVersion
  const canonicalTreeHash = await hashTree(sourceDirectory)

  for (const directory of GENERATED_DIRECTORIES) {
    await rm(path.join(outputRoot, directory), { recursive: true, force: true })
  }
  await rm(path.join(outputRoot, 'gemini-extension.json'), { force: true })

  await replaceDirectory(sourceDirectory, path.join(outputRoot, 'plugins/deyo/skills/deyo'))
  await replaceDirectory(sourceDirectory, path.join(outputRoot, 'skills/deyo'))

  await writeJson(path.join(outputRoot, 'plugins/deyo/.codex-plugin/plugin.json'), {
    name: 'deyo',
    version,
    description: 'Official Deyo plugin for reliable link and local-media transcription through the deyo CLI.',
    author: {
      name: 'Deyo',
      url: 'https://github.com/casatwy',
    },
    homepage: 'https://deyo.miaobi.fun/docs',
    repository: 'https://github.com/casatwy/deyo-skill',
    license: 'UNLICENSED',
    keywords: ['deyo', 'transcription', 'cli', 'audio', 'video'],
    skills: './skills/',
    interface: {
      displayName: 'Deyo',
      shortDescription: 'Transcribe links and local media with Deyo',
      longDescription: 'Use the Deyo CLI for authenticated link or local-media transcription, reliable progress, cleaned text, and exact raw or subtitle output.',
      developerName: 'Deyo',
      category: 'Productivity',
      capabilities: ['Interactive', 'Write'],
      websiteURL: 'https://deyo.miaobi.fun/docs',
      defaultPrompt: [
        'Transcribe this link with Deyo and save cleaned text.',
        'Transcribe this local media file with Deyo.',
      ],
    },
  })

  await writeJson(path.join(outputRoot, 'plugins/deyo/.claude-plugin/plugin.json'), {
    name: 'deyo',
    version,
    description: 'Official Deyo Claude plugin for reliable link and local-media transcription through the deyo CLI.',
    author: {
      name: 'Deyo',
      url: 'https://github.com/casatwy',
    },
    homepage: 'https://deyo.miaobi.fun/ai/install/claude',
    repository: 'https://github.com/casatwy/deyo-skill',
    license: 'UNLICENSED',
    keywords: ['deyo', 'transcription', 'cli', 'audio', 'video'],
    skills: './skills/',
  })

  await writeJson(path.join(outputRoot, '.agents/plugins/marketplace.json'), {
    name: 'deyo-official',
    interface: {
      displayName: 'Deyo Official',
    },
    plugins: [{
      name: 'deyo',
      source: {
        source: 'local',
        path: './plugins/deyo',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    }],
  })

  await writeJson(path.join(outputRoot, '.claude-plugin/marketplace.json'), {
    name: 'deyo-official',
    owner: {
      name: 'Deyo',
    },
    metadata: {
      description: 'Official Deyo plugins',
    },
    plugins: [{
      name: 'deyo',
      source: './plugins/deyo',
      description: 'Transcribe links and local media with the Deyo CLI.',
    }],
  })

  await writeJson(path.join(outputRoot, 'gemini-extension.json'), {
    name: 'deyo',
    version,
    description: 'Official Deyo Gemini extension for reliable link and local-media transcription through the deyo CLI.',
  })

  await writeJson(path.join(outputRoot, 'providers/metadata.json'), {
    schema: 1,
    skillVersion: version,
    minimumCliVersion: manifest.minimumCliVersion,
    canonicalTreeHash,
    source: {
      repository: 'https://github.com/casatwy/deyo-skill.git',
      ref: `v${version}`,
    },
    providers: {
      codex: {
        marketplace: 'deyo-official',
        plugin: 'deyo@deyo-official',
        skillPath: 'plugins/deyo/skills/deyo',
      },
      claude: {
        marketplace: 'deyo-official',
        plugin: 'deyo@deyo-official',
        skillPath: 'plugins/deyo/skills/deyo',
      },
      gemini: {
        extension: 'deyo',
        skillPath: 'skills/deyo',
      },
      openclaw: {
        registry: '@casatwy/deyo',
        license: 'MIT-0',
        skillPath: 'deyo',
      },
    },
  })

  return { ...manifest, canonicalTreeHash }
}

async function assertFileEqual(expected, actual) {
  const [expectedBytes, actualBytes] = await Promise.all([readFile(expected), readFile(actual)])
  if (!expectedBytes.equals(actualBytes)) throw new Error(`Generated file is stale: ${path.relative(root, actual)}`)
}

async function assertDirectoryEqual(expected, actual) {
  const [expectedEntries, actualEntries] = await Promise.all([describeTree(expected), describeTree(actual)])
  if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) {
    throw new Error(`Generated directory is stale: ${path.relative(root, actual)}`)
  }
}

export async function checkProviders() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'deyo-providers-'))
  try {
    await generateProviders(temporaryRoot)
    const files = ['gemini-extension.json']
    const directories = GENERATED_DIRECTORIES
    for (const file of files) await assertFileEqual(path.join(temporaryRoot, file), path.join(root, file))
    for (const directory of directories) {
      await stat(path.join(root, directory))
      await assertDirectoryEqual(path.join(temporaryRoot, directory), path.join(root, directory))
    }
  }
  finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: generate-providers.mjs [--check]')
  }
  if (args[0] === '--check') await checkProviders()
  else await generateProviders()
}
