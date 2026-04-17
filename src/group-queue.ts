import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  LATE_FINALIZE_MAX_RETRIES,
  LATE_FINALIZE_BACKOFF_MS,
  LATE_FINALIZE_EXHAUST_COOLDOWN_MS,
  MAX_MESSAGES_PER_PROMPT,
} from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingRows?: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private processPendingRowsFn:
    | ((chatJid: string, rowIds: string[]) => Promise<boolean>)
    | null = null;
  private groupFolderToChatJid = new Map<string, string>();
  private pendingRowIdsByGroup = new Map<string, Set<string>>();
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingRows: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setProcessPendingRowsFn(
    fn: (chatJid: string, rowIds: string[]) => Promise<boolean>,
  ): void {
    this.processPendingRowsFn = fn;
  }

  registerGroupFolder(chatJid: string, groupFolder: string): void {
    this.groupFolderToChatJid.set(groupFolder, chatJid);
    // Flush any rows enqueued before this mapping existed (startup race).
    const pending = this.pendingRowIdsByGroup.get(groupFolder);
    if (pending && pending.size > 0) {
      this.enqueuePendingRows(groupFolder, [...pending]);
    }
  }

  enqueuePendingRows(groupFolder: string, rowIds: string[]): void {
    if (this.shuttingDown || rowIds.length === 0) return;
    const set = this.pendingRowIdsByGroup.get(groupFolder) ?? new Set<string>();
    for (const id of rowIds) set.add(id);
    this.pendingRowIdsByGroup.set(groupFolder, set);

    const chatJid = this.groupFolderToChatJid.get(groupFolder);
    if (!chatJid) {
      logger.warn(
        { groupFolder },
        'enqueuePendingRows: no chatJid mapping yet; will flush on next registration',
      );
      return;
    }

    const state = this.getGroup(chatJid);
    state.pendingRows = true;
    if (state.active) return;
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      if (!this.waitingGroups.includes(chatJid)) {
        this.waitingGroups.push(chatJid);
      }
      return;
    }
    this.runForGroup(chatJid, 'pendingRows').catch((err) =>
      logger.error(
        { groupFolder, chatJid, err },
        'runForGroup failed for pendingRows',
      ),
    );
  }

  async drainPendingRows(
    chatJid: string,
    groupFolder: string,
  ): Promise<boolean> {
    if (!this.processPendingRowsFn) return true;
    const set = this.pendingRowIdsByGroup.get(groupFolder);
    if (!set || set.size === 0) return true;
    const allRowIds = [...set];
    this.pendingRowIdsByGroup.delete(groupFolder);

    const chunk = allRowIds.slice(0, MAX_MESSAGES_PER_PROMPT);
    const overflow = allRowIds.slice(MAX_MESSAGES_PER_PROMPT);
    if (overflow.length > 0) {
      this.enqueuePendingRows(groupFolder, overflow);
    }

    for (let attempt = 1; attempt <= LATE_FINALIZE_MAX_RETRIES; attempt++) {
      const ok = await this.processPendingRowsFn(chatJid, chunk).catch(
        () => false,
      );
      if (ok) return true;
      if (attempt < LATE_FINALIZE_MAX_RETRIES) {
        await new Promise((r) =>
          setTimeout(r, LATE_FINALIZE_BACKOFF_MS * Math.pow(2, attempt - 1)),
        );
      }
    }
    logger.warn(
      {
        chatJid,
        groupFolder,
        count: chunk.length,
        cooldownMs: LATE_FINALIZE_EXHAUST_COOLDOWN_MS,
      },
      'drainPendingRows: retries exhausted — re-enqueuing after cooldown',
    );
    setTimeout(
      () => this.enqueuePendingRows(groupFolder, chunk),
      LATE_FINALIZE_EXHAUST_COOLDOWN_MS,
    ).unref();
    return false;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /** Check if a group has an active container running. */
  isActive(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state || !state.active) return false;
    // Match sendMessage's liveness check: process may have exited before finally-block cleanup
    if (
      state.process &&
      (state.process.killed || state.process.exitCode != null)
    )
      return false;
    return true;
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    // Don't pipe to a dead container — let messages fall through to enqueueMessageCheck
    if (
      !state.process ||
      state.process.killed ||
      state.process.exitCode != null
    )
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain' | 'pendingRows',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    if (reason !== 'pendingRows') {
      state.pendingMessages = false;
    }
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      let resultOk: boolean;
      if (reason === 'pendingRows') {
        const groupFolder = [...this.groupFolderToChatJid.entries()].find(
          ([, jid]) => jid === groupJid,
        )?.[0];
        if (!groupFolder) {
          logger.error(
            { chatJid: groupJid },
            'runForGroup(pendingRows): no groupFolder mapping',
          );
          resultOk = false;
        } else {
          resultOk = await this.drainPendingRows(groupJid, groupFolder);
        }
      } else if (this.processMessagesFn) {
        resultOk = await this.processMessagesFn(groupJid);
      } else {
        resultOk = true;
      }
      if (resultOk) {
        state.retryCount = 0;
      } else {
        this.scheduleRetry(groupJid, state);
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages (text path)
    if (state.pendingMessages) {
      // If pendingRows is ALSO set, requeue so it fires on the next slot-free.
      if (state.pendingRows) {
        this.waitingGroups.push(groupJid);
      }
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Then pending rows (media-finalize path)
    if (state.pendingRows) {
      state.pendingRows = false;
      this.runForGroup(groupJid, 'pendingRows').catch((err) =>
        logger.error(
          { groupJid, err },
          'runForGroup failed for pendingRows drain',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        // Guard against same-JID duplicate dispatch
        if (state.active) continue;
        state.pendingMessages = false;
        // If pendingRows is ALSO set, re-queue so it fires on next slot-free
        if (state.pendingRows) {
          this.waitingGroups.push(nextJid);
        }
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else if (state.pendingRows) {
        if (state.active) continue;
        state.pendingRows = false;
        this.runForGroup(nextJid, 'pendingRows').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'runForGroup failed for pendingRows (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
