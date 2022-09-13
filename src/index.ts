import { resolve } from 'path'
import { unlink, stat } from 'fs/promises'
import findWorkspaceDir from '@pnpm/find-workspace-dir'
import printDiff from 'print-diff'
import { findWorkspacePackagesNoCheck } from '@pnpm/find-workspace-packages'
import { UpdateOptions, UpdateOptionsWithFormats } from './updater/updateOptions.js'
import { BaseFormatPlugins, FormatPlugin } from './updater/formatPlugin.js'
import { builtInFormatPlugins } from './updater/builtInFormats.js'
import { clone } from './clone.js'

export {
  createFormat,
  type BaseFormatPlugins,
  type FormatPlugin,
  type FormatPluginFnOptions,
} from './updater/formatPlugin.js'
export { createUpdateOptions, type UpdateOptions, type UpdateOptionsWithFormats } from './updater/updateOptions.js'
export type { Files } from './updater/files'

export default async function (opts: { test?: boolean }) {
  const workspaceDir = await findWorkspaceDir['default'](process.cwd())
  if (!workspaceDir) throw new Error(`Cannot find a workspace at ${process.cwd()}`)
  const updater = await import(`file://${resolve('.meta-updater/main.mjs').replace(/\\/g, '/')}`)
  const updateOptions = await updater.default(workspaceDir)
  const result = await performUpdates(workspaceDir, updateOptions, opts)
  if (opts.test && result != null) {
    const out = process.stderr
    for (const error of result) {
      if ('exception' in error) {
        out.write(`ERROR: ${error.exception}`)
      } else {
        const { path, actual, expected } = error
        out.write(`ERROR: ${path} is not up-to-date`)
        printJsonDiff(actual, expected, out)
      }
    }
    process.exit(1)
  }
}

type UpdateError =
  | {
      expected: unknown
      actual: unknown
      path: string
    }
  | {
      exception: any
    }

export async function performUpdates<
  FileNameWithOptions extends string,
  UserDefinedFormatPlugins extends BaseFormatPlugins
>(
  workspaceDir: string,
  update2: UpdateOptions<FileNameWithOptions> | UpdateOptionsWithFormats<FileNameWithOptions, UserDefinedFormatPlugins>,
  opts?: { test?: boolean }
): Promise<null | UpdateError[]> {
  let pkgs = await findWorkspacePackagesNoCheck(workspaceDir)

  const { files } = update2
  const formats = 'formats' in update2 ? { ...builtInFormatPlugins, ...update2.formats } : builtInFormatPlugins

  const promises = pkgs.flatMap(({ dir, manifest, writeProjectManifest }) =>
    Object.keys(files).map(async (fileKey) => {
      const updateTargetFile = !opts?.test
      const { file, formatPlugin } = parseFileKey(fileKey, formats)
      const resolvedPath = resolve(dir, file)
      const formatHandlerOptions = {
        file,
        dir,
        manifest: clone(manifest),
        resolvedPath,
        _writeProjectManifest: writeProjectManifest,
      }
      const actual = (await fileExists(resolvedPath)) ? await formatPlugin.read(formatHandlerOptions) : null
      const expected = await formatPlugin.update(clone(actual), files[fileKey], formatHandlerOptions)
      const equal =
        (actual == null && expected == null) ||
        (actual != null && expected != null && (await formatPlugin.equal(expected, actual, formatHandlerOptions)))
      if (equal) {
        return
      }

      if (updateTargetFile) {
        if (expected == null) {
          await unlink(resolvedPath)
        } else {
          await formatPlugin.write(expected, formatHandlerOptions)
        }
        return
      }

      return { actual, expected, path: resolvedPath }
    })
  )

  const diffs = await Promise.allSettled(promises)
  const errors = diffs.flatMap((diff) => {
    switch (diff.status) {
      case 'fulfilled':
        return diff.value ?? []
      case 'rejected':
        return diff.reason
    }
  })
  return errors.length > 0 ? errors : null
}

function printJsonDiff(actual: unknown, expected: unknown, out: NodeJS.WriteStream) {
  printDiff(
    typeof actual !== 'string' ? JSON.stringify(actual, null, 2) : actual,
    typeof expected !== 'string' ? JSON.stringify(expected, null, 2) : expected,
    out
  )
}

async function fileExists(path: string) {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch (error) {
    return false
  }
}

function parseFileKey(fileKey: string, formatPlugins: Record<string, FormatPlugin<unknown>>) {
  const forcedExtensionMatch = fileKey.match(/(?<file>.*?)\s*\[(?<extension>.*?)\]$/)
  if (forcedExtensionMatch) {
    const { extension, file } = forcedExtensionMatch.groups!
    const formatPlugin = formatPlugins[extension]

    if (!formatPlugin) {
      throw new Error(
        `Configuration error: there is no format plugin for fileKey "${fileKey}" with forced extension "${extension}"`
      )
    }

    return {
      file,
      extension,
      formatPlugin,
    }
  }

  const extension = Object.keys(formatPlugins).find((extension) => fileKey.endsWith(extension))
  if (!extension) {
    throw new Error(
      `Configuration error: there is no format plugin for fileKey "${fileKey}", supported extensions are ${Object.keys(
        formatPlugins
      )}`
    )
  }

  return {
    file: fileKey,
    extension,
    formatPlugin: formatPlugins[extension],
  }
}
