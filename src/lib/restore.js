/**
 * Restoring one captured file to its pre-Turn state.
 *
 * Three mechanisms are used on purpose:
 *
 *  - content that was valid UTF-8 goes through the Harness `fs` service, so the
 *    restore obeys the same path resolution, locking and version guards as a
 *    model-issued write;
 *  - a plugin-originated write has no Agent context, and the filesystem service
 *    refuses to write without one ("file access denied under workspace-write
 *    mode"). The policy is therefore rebuilt from the Turn's own workspace: the
 *    same confinement the Turn ran under, widening only for a path the archive
 *    recorded outside that workspace;
 *  - a binary pre-image, or a file the Turn created and that must therefore
 *    disappear, needs an operation the `fs` service does not expose. Those go
 *    through Node directly, on a path that is never client input: it is the
 *    exact absolute path recorded while the Turn ran.
 */

import { rm, writeFile } from 'node:fs/promises';

const FULL_ACCESS = 'danger-full-access';
const WORKSPACE_WRITE = 'workspace-write';

/**
 * Rebuild the write policy for one restore target.
 *
 * Inside the Turn's workspace the narrower `workspace-write` mode is enough;
 * outside it, only the wider mode can reach the file, and using it is still
 * symmetric with the write the Turn itself performed there.
 *
 * @param {{
 *   fsService: { resolve: Function, contains: Function },
 *   target: object,
 *   workspaceRoot: string | undefined,
 * }} input
 * @returns {Promise<{ mode: string, workspaceRoot: string }>}
 */
async function sandboxPolicyFor({ fsService, target, workspaceRoot }) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot !== ''
    ? workspaceRoot
    : process.cwd();
  let inside = false;
  try {
    const rootTarget = await fsService.resolve(root);
    inside = fsService.contains(rootTarget, target) === true;
  } catch {
    inside = false;
  }
  return { mode: inside ? WORKSPACE_WRITE : FULL_ACCESS, workspaceRoot: root };
}

/**
 * @param {{
 *   fsService: { resolve: Function, stat: Function, contains: Function, writeText: Function },
 *   archive: { readBlob: (name: string | null) => Promise<Buffer | null> },
 *   file: {
 *     path: string, displayPath: string, existed: boolean, text: boolean,
 *     blob: string | null, size: number, reason?: string,
 *   },
 *   workspaceRoot?: string,
 * }} input
 * @returns {Promise<{ path: string, status: 'restored' | 'deleted' | 'skipped' | 'failed', message?: string }>}
 */
export async function restoreFile({ fsService, archive, file, workspaceRoot }) {
  const displayPath = typeof file.displayPath === 'string' && file.displayPath !== ''
    ? file.displayPath
    : file.path;

  if (file.existed !== true) {
    // The Turn created this file, so the pre-Turn state is "absent".
    await rm(file.path, { force: true });
    return { path: displayPath, status: 'deleted' };
  }

  const bytes = await archive.readBlob(file.blob);
  if (bytes === null) {
    return {
      path: displayPath,
      status: 'skipped',
      message: 'the recorded pre-Turn content is no longer available',
    };
  }

  const target = await fsService.resolve(file.path);

  if (file.text === true) {
    const policy = await sandboxPolicyFor({ fsService, target, workspaceRoot });
    const current = await fsService.stat(target);
    const expected = current === undefined || current === null
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: current.version };
    await fsService.writeText(target, bytes.toString('utf8'), expected, undefined, policy);
    return { path: displayPath, status: 'restored' };
  }

  await writeFile(file.path, bytes);
  return { path: displayPath, status: 'restored' };
}
