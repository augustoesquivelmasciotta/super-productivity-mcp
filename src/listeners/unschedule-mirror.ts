// Mirrors SP "unschedule" actions into ~/Documents/Áreas/Planificación/backlog/*.md.
//
// When a task's dueDay AND dueWithTime both transition to null (from at least one
// being set), the task is appended to the corresponding backlog file under
// `## Inbox auto (de SP)` → `### Unscheduled (era today, sin tiempo)`, then deleted
// from SP. Estructura tasks (daily routines that /dia recreates) are deleted
// without mirror. Inbox/Resources tasks are ignored.
//
// Order of ops is verify-before-delete: write → re-read file and grep for the SP
// id → only then delete from SP. If verification fails, the task stays in SP
// unscheduled and the next event re-tries (idempotent by SP id grep).
//
// Wiring lives in src/index.ts: on each socket connection, registers
// `socket.on('event:taskUpdate', ...)` and seeds the cache via spClient.getTasks().
//
// Payload shape (from SP `taskUpdate` hook): { taskId, task, changes }. Older
// shape was { action, task, taskId, taskState } from anyTaskUpdate; extractTask
// handles both via the `p.task && p.task.id` branch. We migrated from
// anyTaskUpdate to taskUpdate on 2026-04-25 because anyTaskUpdate doesn't
// listen to UI scheduling actions (unscheduleTask, etc.). See decisiones.md.

import { promises as fs } from 'fs';
import * as path from 'path';

const BACKLOG_DIR = '/Users/augus/Documents/Áreas/Planificación/backlog';

// projectId → backlog file slug. Source of truth: setup-tecnico-sp.md.
//
// Materias (HSL/HSA/ALG/FIS/ASA/SO/TSC-A + "Materias generales") all mirror
// to a single backlog-materias.md (decisión 2026-04-30: backlogs por materia
// fueron consolidados en commit 044b787; los proyectos SP siguen separados
// por materia en el sidebar pero comparten sumidero). "Materias generales"
// es el sub-proyecto para tareas cross-materia (ej. "pre-clase semana
// próxima — multiple textos").
const PROJECT_TO_BACKLOG: Record<string, string> = {
  'cHcv2nWbtfIaoZ-LUCAL5': 'tlon',
  'fLlNKgfND3nEQx6Y6511V': 'mc',
  'vSJoky02vwSTglObEFYi0': 'comms',
  'pBnSCr1M9xoTt8z_KPeun': 'community',
  'XwwN-omNPWWeoWM_ETaR1': 'misc',
  'kKVR_zz9ct-NLTiu8d66M': 'materias', // hsl
  'cZD26eFBOFvdNzlOTcoed': 'materias', // hsa
  'MrpohgHg4BGSbugB3LRCI': 'materias', // alg
  '3Wr6SeZ1RvnDse0pKKKcO': 'materias', // fis
  'NhZjvcWRcPlmlzGKYl9vj': 'materias', // asa
  'GPPx5PiB3fIDS7FVCgOsZ': 'materias', // so
  '3UpjaXQln228fds8_o6va': 'materias', // tsc-a
  'GUV8T1Wh53bGVsJbAtAFK': 'materias', // materias generales (cross-materia)
  'V28uij7JjFFgcFCtfnR1h': 'social',
};

const ESTRUCTURA_PROJECT_ID = 'pjhVh1Dz8L-7xHP_ehm4E'; // delete without mirror
const INBOX_PROJECT_ID = 'INBOX_PROJECT';                // skip (no schedule to lose)
const RESOURCES_PROJECT_ID = '41Ap_QZLRYCAtO7DxSCFX';   // skip (not tasks)
const SKIP_PROJECT_IDS = new Set([INBOX_PROJECT_ID, RESOURCES_PROJECT_ID]);

const SECTION_HEADER = '## Inbox auto (de SP)';
const SUBSECTION_HEADER = '### Unscheduled (era today, sin tiempo)';

interface TaskLite {
  id: string;
  title: string;
  projectId?: string;
  dueDay?: string | null;
  dueWithTime?: number | null;
  notes?: string | null;
}

interface SPClient {
  getTasks(): Promise<TaskLite[]>;
  deleteTask(taskId: string): Promise<void>;
}

function tsLog(...parts: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [unschedule-mirror]`, ...parts);
}

// Verbose per-event tracing. Off by default to keep the log clean. Toggle
// SP_MCP_DEBUG_EVENTS=1 in launchd plist (then restart the daemon) when
// diagnosing why a transition didn't fire as expected.
const DEBUG_EVENTS = process.env.SP_MCP_DEBUG_EVENTS === "1";

function isScheduled(t: TaskLite): boolean {
  return !!(t.dueDay || t.dueWithTime);
}

function backlogPathFor(projectId: string | undefined): string | null {
  if (!projectId) return null;
  const slug = PROJECT_TO_BACKLOG[projectId];
  return slug ? path.join(BACKLOG_DIR, `backlog-${slug}.md`) : null;
}

// Single line containing the SP id, used for idempotency grep.
function entryFor(task: TaskLite): string {
  const today = new Date().toISOString().slice(0, 10);
  const title = task.title.replace(/\n/g, ' ').trim();
  const noteLine = (task.notes || '').replace(/\n/g, ' ').trim();
  const noteSuffix = noteLine ? `. ${noteLine}` : '';
  return `- ${title}\n  > Unscheduled de SP el ${today}. SP id: ${task.id}${noteSuffix}\n`;
}

// Match a canonical mirror line for this task id, NOT just any occurrence of
// "SP id: <id>" in the file. The substring could appear inside a user note
// (extremely unlikely for 21-char random ids, but possible) and a loose match
// would let verifyMirror pass on a write that silently failed → task deleted
// from SP without being saved. The regex anchors to our entry shape:
//   `  > Unscheduled de SP el YYYY-MM-DD. SP id: <id>(. <notes>|<eol>)`
// so only lines actually written by this listener qualify.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alreadyMirrored(fileContents: string, taskId: string): boolean {
  const re = new RegExp(
    `^  > Unscheduled de SP el \\d{4}-\\d{2}-\\d{2}\\. SP id: ${escapeRegex(taskId)}(?:$|\\.)`,
    'm'
  );
  return re.test(fileContents);
}

// Append the entry under the right subsection. Creates section/subsection if missing.
async function appendToBacklog(filePath: string, task: TaskLite): Promise<void> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Backlog file doesn't exist → bootstrap it. Should be rare; backlogs are
      // created by hand. We log and bail rather than create silently.
      throw new Error(`backlog file does not exist: ${filePath}`);
    }
    throw err;
  }

  if (alreadyMirrored(contents, task.id)) {
    tsLog(`already mirrored, skipping write for ${task.id} (${task.title})`);
    return;
  }

  const entry = entryFor(task);
  let updated: string;

  if (contents.includes(SUBSECTION_HEADER)) {
    // Insert right after the subsection header line.
    updated = contents.replace(
      SUBSECTION_HEADER,
      `${SUBSECTION_HEADER}\n${entry}`
    );
  } else if (contents.includes(SECTION_HEADER)) {
    // Section exists but subsection doesn't — add subsection then entry.
    updated = contents.replace(
      SECTION_HEADER,
      `${SECTION_HEADER}\n\n${SUBSECTION_HEADER}\n${entry}`
    );
  } else {
    // Append section + subsection + entry at the end (before Someday/Maybe if present).
    const block = `\n${SECTION_HEADER}\n\n${SUBSECTION_HEADER}\n${entry}`;
    if (contents.includes('## Someday/Maybe')) {
      updated = contents.replace('## Someday/Maybe', `${block}\n## Someday/Maybe`);
    } else {
      updated = contents.endsWith('\n') ? contents + block : contents + '\n' + block;
    }
  }

  await fs.writeFile(filePath, updated, 'utf8');
}

// Re-read file and confirm the SP id is present. Returns true if found.
async function verifyMirror(filePath: string, taskId: string): Promise<boolean> {
  const contents = await fs.readFile(filePath, 'utf8');
  return alreadyMirrored(contents, taskId);
}

export class UnscheduleMirror {
  private cache: Map<string, { dueDay: string | null; dueWithTime: number | null }> = new Map();
  private inFlight: Set<string> = new Set(); // prevent re-entrancy on the same id
  private spClient: SPClient;

  constructor(spClient: SPClient) {
    this.spClient = spClient;
  }

  // Seed cache so we don't fire on tasks that were already unscheduled before
  // the server started. Called on each plugin connection.
  async seed(): Promise<void> {
    try {
      const tasks = await this.spClient.getTasks();
      this.cache.clear();
      for (const t of tasks) {
        this.cache.set(t.id, {
          dueDay: t.dueDay ?? null,
          dueWithTime: t.dueWithTime ?? null,
        });
      }
      tsLog(`seeded cache with ${tasks.length} tasks`);
    } catch (err: any) {
      tsLog(`seed failed: ${err.message ?? err}`);
    }
  }

  // anyTaskUpdate payloads are heterogeneous depending on SP version: sometimes
  // the full task, sometimes { task }, sometimes { taskChanges, task }. We try
  // a few shapes; if none match, we log and skip — the next event for the same
  // task will likely have a usable shape.
  private extractTask(payload: unknown): TaskLite | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as any;
    if (p.id && typeof p.id === 'string' && 'title' in p) return p as TaskLite;
    if (p.task && typeof p.task === 'object' && p.task.id) return p.task as TaskLite;
    return null;
  }

  // taskCreated hook payload: { taskId, task }. We hydrate the cache so a
  // subsequent unschedule on a freshly-created task is detected as a real
  // transition (and not skipped because prev was undefined).
  handleTaskCreated(payload: unknown): void {
    const task = this.extractTask(payload);
    if (!task) return;
    this.cache.set(task.id, {
      dueDay: task.dueDay ?? null,
      dueWithTime: task.dueWithTime ?? null,
    });
    if (DEBUG_EVENTS) {
      tsLog(`[taskCreated] cached id=${task.id} dueDay=${task.dueDay ?? 'null'}/${task.dueWithTime ?? 'null'}`);
    }
  }

  // taskDelete hook payload: { taskId } (single) or { taskIds: [...] } (batch).
  // We strip from the cache so deleted ids don't linger as zombies.
  handleTaskDelete(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as any;
    const ids: string[] = [];
    if (typeof p.taskId === 'string') ids.push(p.taskId);
    if (Array.isArray(p.taskIds)) {
      for (const id of p.taskIds) if (typeof id === 'string') ids.push(id);
    }
    for (const id of ids) {
      this.cache.delete(id);
      this.inFlight.delete(id);
    }
    if (DEBUG_EVENTS && ids.length) {
      tsLog(`[taskDelete] purged ${ids.length} id(s) from cache: ${ids.join(',')}`);
    }
  }

  // `[Task Shared] planTasksForToday` action payload (filtered by plugin):
  //   { action: { taskIds, parentTaskMap, isShowSnack, meta } }
  // The action does NOT flow through the taskUpdate hook (the only known gap),
  // so we listen to it via the filtered action hook and update the cache to
  // reflect the new scheduled state. Without this, a drag-to-Today + drag-back
  // sequence in the same session would have stale cache and miss the unschedule.
  handleTaskScheduledForToday(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const action = (payload as any).action;
    if (!action || !Array.isArray(action.taskIds)) return;
    const today = new Date().toISOString().slice(0, 10);
    for (const id of action.taskIds) {
      if (typeof id !== 'string') continue;
      const prev = this.cache.get(id);
      this.cache.set(id, {
        dueDay: today,
        dueWithTime: prev?.dueWithTime ?? null,
      });
    }
    if (DEBUG_EVENTS) {
      tsLog(`[planTasksForToday] cached ${action.taskIds.length} id(s) as scheduled to ${today}`);
    }
  }

  async handleEvent(payload: unknown): Promise<void> {
    const task = this.extractTask(payload);
    if (!task) {
      tsLog('skipping event: could not extract task from payload', JSON.stringify(payload).slice(0, 200));
      return;
    }
    if (this.inFlight.has(task.id)) return;

    const prev = this.cache.get(task.id);
    const wasScheduled = prev ? !!(prev.dueDay || prev.dueWithTime) : false;
    const nowScheduled = isScheduled(task);

    if (DEBUG_EVENTS) {
      tsLog(
        `[event] id=${task.id} title="${(task.title || '').slice(0, 40)}" ` +
        `prev=${prev ? `${prev.dueDay}/${prev.dueWithTime}` : 'none'} ` +
        `now=${task.dueDay ?? 'null'}/${task.dueWithTime ?? 'null'} ` +
        `wasScheduled=${wasScheduled} nowScheduled=${nowScheduled}`,
      );
    }

    // Always update cache after deciding.
    const updateCache = () => {
      this.cache.set(task.id, {
        dueDay: task.dueDay ?? null,
        dueWithTime: task.dueWithTime ?? null,
      });
    };

    if (!wasScheduled || nowScheduled) {
      updateCache();
      return; // not an unschedule transition
    }

    // wasScheduled && !nowScheduled → unschedule transition
    this.inFlight.add(task.id);
    try {
      await this.handleUnschedule(task);
    } catch (err: any) {
      tsLog(`handleUnschedule failed for ${task.id} (${task.title}): ${err.message ?? err}`);
    } finally {
      this.inFlight.delete(task.id);
      updateCache();
    }
  }

  private async handleUnschedule(task: TaskLite): Promise<void> {
    // Estructura: routines, /dia recreates them. Delete without mirror.
    if (task.projectId === ESTRUCTURA_PROJECT_ID) {
      tsLog(`Estructura task unscheduled, deleting without mirror: ${task.id} (${task.title})`);
      await this.spClient.deleteTask(task.id);
      this.cache.delete(task.id);
      return;
    }

    // Inbox / Resources: skip (Inbox tasks aren't meant to carry schedule state;
    // Resources aren't tasks).
    if (task.projectId && SKIP_PROJECT_IDS.has(task.projectId)) {
      tsLog(`skip-list project, ignoring: ${task.id} (${task.title})`);
      return;
    }

    const filePath = backlogPathFor(task.projectId);
    if (!filePath) {
      tsLog(
        `no backlog mapped for projectId=${task.projectId ?? 'undefined'}; ` +
        `task ${task.id} stays in SP unscheduled. Add mapping in unschedule-mirror.ts.`
      );
      return;
    }

    // Step 1: write
    await appendToBacklog(filePath, task);

    // Step 2: verify
    const ok = await verifyMirror(filePath, task.id);
    if (!ok) {
      tsLog(
        `verify failed: SP id ${task.id} not found in ${filePath} after write. ` +
        `Aborting delete; task stays in SP unscheduled.`
      );
      return;
    }

    // Step 3: delete from SP
    await this.spClient.deleteTask(task.id);
    this.cache.delete(task.id);
    tsLog(`mirrored ${task.id} (${task.title}) → ${path.basename(filePath)} and deleted from SP`);
  }
}
