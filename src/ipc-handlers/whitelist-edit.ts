import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { CONFIG_PATH, IntercomWhitelist } from '../intercom-whitelist.js';
import { IpcHandler, registerIpcHandler } from '../ipc-handlers.js';
import { logger } from '../logger.js';

type WhitelistAction =
  | 'add_auto_approved'
  | 'remove_auto_approved'
  | 'add_always_ask'
  | 'remove_always_ask'
  | 'add_group'
  | 'update_group';

const VALID_ACTIONS = new Set<WhitelistAction>([
  'add_auto_approved',
  'remove_auto_approved',
  'add_always_ask',
  'remove_always_ask',
  'add_group',
  'update_group',
]);

function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  response: object,
): void {
  // Sanitize requestId to prevent path traversal (mirrors writeIpcErrorResponse)
  const safeId = path.basename(requestId);
  if (!safeId || safeId !== requestId) {
    logger.warn(
      { requestId },
      'Rejected unsafe requestId in whitelist_edit response',
    );
    return;
  }
  const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responseFile = path.join(responsesDir, `${safeId}.json`);
  const tempFile = `${responseFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(response));
  fs.renameSync(tempFile, responseFile);
}

/**
 * Read the whitelist config file directly (not the cached copy).
 * Returns the raw file content so edits reflect the latest on-disk state.
 */
function readWhitelistFromDisk(): IntercomWhitelist {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IntercomWhitelist>;
    const rawGroups =
      parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {};
    // Normalize each group entry so handlers can safely access fields
    const groups: IntercomWhitelist['groups'] = {};
    for (const [name, entry] of Object.entries(rawGroups)) {
      const e = entry && typeof entry === 'object' ? entry : ({} as any);
      groups[name] = {
        intercom: e.intercom === true,
        sync_sessions: e.sync_sessions === true,
        auto_approved: Array.isArray(e.auto_approved) ? e.auto_approved : [],
      };
    }
    return {
      groups,
      always_ask: Array.isArray(parsed.always_ask) ? parsed.always_ask : [],
      expired_retention_days:
        typeof parsed.expired_retention_days === 'number'
          ? parsed.expired_retention_days
          : 30,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { groups: {}, always_ask: [], expired_retention_days: 30 };
    }
    throw err;
  }
}

/**
 * Write the whitelist back to the config file. The file watcher in
 * intercom-whitelist.ts will detect the change, reload the cache,
 * and refresh the snapshot for main.
 */
function writeWhitelistToDisk(whitelist: IntercomWhitelist): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tempFile = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(whitelist, null, 2));
  fs.renameSync(tempFile, CONFIG_PATH);
}

const handler: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const action = data.action as string | undefined;
  const group = data.group as string | undefined;
  const subject = data.subject as string | undefined;
  const settings = data.settings as
    | { intercom?: boolean; sync_sessions?: boolean }
    | undefined;

  const respond = (response: object) => {
    if (requestId) {
      writeIpcResponse(context.sourceGroup, requestId, response);
    }
  };

  // Authorization: only main can edit the whitelist
  if (!context.isMain) {
    logger.warn(
      { sourceGroup: context.sourceGroup },
      'Unauthorized whitelist_edit attempt blocked — only main can edit the whitelist',
    );
    respond({
      status: 'error',
      error: 'Unauthorized: only the main container can edit the whitelist',
    });
    return;
  }

  if (!action || !VALID_ACTIONS.has(action as WhitelistAction)) {
    logger.warn({ action }, 'Invalid whitelist_edit action');
    respond({
      status: 'error',
      error: `Invalid action: ${action}. Valid actions: ${[...VALID_ACTIONS].join(', ')}`,
    });
    return;
  }

  try {
    const whitelist = readWhitelistFromDisk();

    switch (action as WhitelistAction) {
      case 'add_auto_approved': {
        if (!group || !subject) {
          respond({
            status: 'error',
            error: 'add_auto_approved requires group and subject',
          });
          return;
        }
        // Cannot add to auto_approved if subject is in always_ask
        if (whitelist.always_ask.includes(subject)) {
          respond({
            status: 'error',
            error: `Cannot auto-approve "${subject}" — it is in the always_ask list. Remove it from always_ask first.`,
          });
          return;
        }
        if (!whitelist.groups[group]) {
          respond({
            status: 'error',
            error: `Group "${group}" not found in whitelist`,
          });
          return;
        }
        if (!whitelist.groups[group].auto_approved.includes(subject)) {
          whitelist.groups[group].auto_approved.push(subject);
        }
        break;
      }

      case 'remove_auto_approved': {
        if (!group || !subject) {
          respond({
            status: 'error',
            error: 'remove_auto_approved requires group and subject',
          });
          return;
        }
        if (!whitelist.groups[group]) {
          respond({
            status: 'error',
            error: `Group "${group}" not found in whitelist`,
          });
          return;
        }
        whitelist.groups[group].auto_approved = whitelist.groups[
          group
        ].auto_approved.filter((s) => s !== subject);
        break;
      }

      case 'add_always_ask': {
        if (!subject) {
          respond({
            status: 'error',
            error: 'add_always_ask requires subject',
          });
          return;
        }
        if (!whitelist.always_ask.includes(subject)) {
          whitelist.always_ask.push(subject);
        }
        break;
      }

      case 'remove_always_ask': {
        if (!subject) {
          respond({
            status: 'error',
            error: 'remove_always_ask requires subject',
          });
          return;
        }
        logger.info(
          { subject },
          'Removing subject from always_ask — this is a sensitive operation',
        );
        whitelist.always_ask = whitelist.always_ask.filter(
          (s) => s !== subject,
        );
        break;
      }

      case 'add_group': {
        if (!group) {
          respond({ status: 'error', error: 'add_group requires group' });
          return;
        }
        if (whitelist.groups[group]) {
          respond({
            status: 'error',
            error: `Group "${group}" already exists in whitelist`,
          });
          return;
        }
        // New groups start with empty auto_approved (Requirement 4.1)
        whitelist.groups[group] = {
          intercom: settings?.intercom ?? true,
          sync_sessions: settings?.sync_sessions ?? false,
          auto_approved: [],
        };
        break;
      }

      case 'update_group': {
        if (!group) {
          respond({ status: 'error', error: 'update_group requires group' });
          return;
        }
        if (!whitelist.groups[group]) {
          respond({
            status: 'error',
            error: `Group "${group}" not found in whitelist`,
          });
          return;
        }
        if (settings) {
          if (typeof settings.intercom === 'boolean') {
            whitelist.groups[group].intercom = settings.intercom;
          }
          if (typeof settings.sync_sessions === 'boolean') {
            whitelist.groups[group].sync_sessions = settings.sync_sessions;
          }
        }
        break;
      }
    }

    writeWhitelistToDisk(whitelist);

    logger.info({ action, group, subject }, 'Whitelist edit applied');
    respond({ status: 'ok', action, group, subject });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, action, group, subject }, 'Whitelist edit failed');
    respond({ status: 'error', error: errorMessage });
  }
};

registerIpcHandler('whitelist_edit', handler);
