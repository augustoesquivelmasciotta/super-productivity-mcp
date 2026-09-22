"""End-to-end tests for the unschedule → backlog mirror listener.

Covers cases not exercised by the original 2026-04-25 test:
  1. Inbox skip (INBOX_PROJECT)
  2. Resources skip (41Ap_QZLRYCAtO7DxSCFX)
  3. Idempotency: pre-existing CANONICAL mirror entry → no duplicate write,
     task still deleted from SP (verifyMirror passes via canonical match).
  4. Project without mapping (Socio orgas) → task stays in SP, listener logs warning.
  5. Strict-match: pre-existing user note containing "SP id: <id>" but NOT a
     canonical entry → listener does NOT skip, writes its own entry, deletes
     from SP. Closes the previous loose-match hole that risked silent data loss.

Assumes SP server is up at http://127.0.0.1:3996/mcp and the SP plugin is connected.
Sleeps between socket-driven steps to give the listener time to process events.

Run: python3 scripts/test_unschedule_mirror.py
Cost: ~30s, creates and cleans up test tasks in real SP projects.

SKIPPED SINCE 2026-09-22 (campaign propose-20260922-173950). El listener
unschedule-mirror quedo desregistrado en src/index.ts (SP es ahora la unica
fuente del backlog), asi que los 5 tests E2E de abajo fallarian todos: no hay
nada escuchando event:taskUpdate. El guard de main() lo detecta y sale 0 con
SKIP en vez de reportar 5 falsos negativos. Si el mirror se re-habilita (ver el
banner de src/listeners/unschedule-mirror.ts), el guard lo nota solo y los
tests vuelven a correr sin tocar este archivo.
"""
import os
import sys
import time
import re

sys.path.insert(0, "/Users/augus/Documents/Áreas/Planificación/scripts")
import sp  # type: ignore

INBOX = "INBOX_PROJECT"
RESOURCES = "41Ap_QZLRYCAtO7DxSCFX"
MISC = "XwwN-omNPWWeoWM_ETaR1"
SOCIO_ORGAS = "mdB5UdNmwlM695S8Dbwdv"

LOG = "/Users/augus/Library/Logs/super-productivity-mcp.log"
BACKLOG_MISC = "/Users/augus/Documents/Áreas/Planificación/backlog/backlog-misc.md"

WAIT = 2.5  # seconds for socket round-trip + listener processing


def read_log_since(start_offset: int) -> str:
    with open(LOG, "rb") as f:
        f.seek(start_offset)
        return f.read().decode("utf-8", errors="replace")


def log_size() -> int:
    with open(LOG, "rb") as f:
        f.seek(0, 2)
        return f.tell()


def task_exists(task_id: str, project_id: str) -> bool:
    res = sp.list_tasks(projectId=project_id, includeArchived=False)
    items = res.get("tasks", []) if isinstance(res, dict) else []
    return any(t.get("id") == task_id for t in items)


def schedule(task_id: str, day: str = "2026-04-26") -> None:
    sp.update_task(task_id, dueDay=day, verify=True)


def unschedule(task_id: str) -> None:
    # IMPORTANT: scheduled→unscheduled transition must reach the listener.
    sp.update_task(task_id, dueDay=None, dueWithTime=None, verify=False)


def make_unscheduled_task(project_id: str, title: str) -> str:
    res = sp.create_task(title=title, projectId=project_id)
    tid = res.get("taskId") or res.get("id")
    if not tid:
        raise RuntimeError(f"create_task returned no id: {res}")
    return tid


def cleanup(task_id: str) -> None:
    try:
        sp.delete_task(task_id)
    except Exception as e:
        print(f"  cleanup of {task_id} failed: {e}")


def assert_log_has(snippet: str, log: str, label: str) -> bool:
    if snippet in log:
        print(f"  ✓ log contains: {snippet[:80]}")
        return True
    print(f"  ✗ log missing: {snippet[:80]}  ({label})")
    return False


def count_sp_id_lines(file_path: str, task_id: str) -> int:
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read().count(f"SP id: {task_id}")


def test_inbox_skip() -> dict:
    print("\n=== TEST 1: Inbox skip ===")
    log_start = log_size()
    title = "_test_inbox_skip_DELETE_ME"
    tid = make_unscheduled_task(INBOX, title)
    print(f"  created {tid} in Inbox")
    time.sleep(0.5)
    schedule(tid)
    print(f"  scheduled {tid}")
    time.sleep(WAIT)
    unschedule(tid)
    print(f"  unscheduled {tid}")
    time.sleep(WAIT)
    log = read_log_since(log_start)
    ok_log = assert_log_has(f"skip-list project, ignoring: {tid}", log, "T1 log")
    still_in_sp = task_exists(tid, INBOX)
    if still_in_sp:
        print(f"  ✓ task still in SP unscheduled (skip respected)")
    else:
        print(f"  ✗ task got deleted (should have been skipped)")
    cleanup(tid)
    return {"name": "T1 Inbox skip", "passed": ok_log and still_in_sp}


def test_resources_skip() -> dict:
    print("\n=== TEST 2: Resources skip ===")
    log_start = log_size()
    title = "_test_resources_skip_DELETE_ME"
    tid = make_unscheduled_task(RESOURCES, title)
    print(f"  created {tid} in Resources")
    time.sleep(0.5)
    schedule(tid)
    print(f"  scheduled {tid}")
    time.sleep(WAIT)
    unschedule(tid)
    print(f"  unscheduled {tid}")
    time.sleep(WAIT)
    log = read_log_since(log_start)
    ok_log = assert_log_has(f"skip-list project, ignoring: {tid}", log, "T2 log")
    still_in_sp = task_exists(tid, RESOURCES)
    if still_in_sp:
        print(f"  ✓ task still in SP unscheduled")
    else:
        print(f"  ✗ task got deleted (should have been skipped)")
    cleanup(tid)
    return {"name": "T2 Resources skip", "passed": ok_log and still_in_sp}


def test_idempotency() -> dict:
    print("\n=== TEST 3: Idempotency (pre-existing canonical entry) ===")
    log_start = log_size()
    title = "_test_idempotency_DELETE_ME"
    tid = make_unscheduled_task(MISC, title)
    print(f"  created {tid} in Misc")
    time.sleep(0.5)
    schedule(tid)
    print(f"  scheduled {tid}")
    time.sleep(WAIT)
    # Pre-write a CANONICAL mirror entry (matches the listener's strict regex).
    today = "2026-04-25"
    probe = (
        f"\n- {title}\n"
        f"  > Unscheduled de SP el {today}. SP id: {tid}\n"
    )
    with open(BACKLOG_MISC, "a", encoding="utf-8") as f:
        f.write(probe)
    print(f"  pre-wrote canonical entry for {tid}")
    unschedule(tid)
    print(f"  unscheduled {tid}")
    time.sleep(WAIT)
    log = read_log_since(log_start)
    ok_skip = assert_log_has(f"already mirrored, skipping write for {tid}", log, "T3 skip")
    ok_delete = assert_log_has(f"mirrored {tid}", log, "T3 delete")
    deleted_from_sp = not task_exists(tid, MISC)
    n_lines = count_sp_id_lines(BACKLOG_MISC, tid)
    print(f"  occurrences of 'SP id: {tid}' in backlog: {n_lines} (expected 1)")
    # Cleanup probe
    with open(BACKLOG_MISC, "r", encoding="utf-8") as f:
        contents = f.read()
    contents = contents.replace(probe, "")
    with open(BACKLOG_MISC, "w", encoding="utf-8") as f:
        f.write(contents)
    print("  cleaned probe entry")
    return {
        "name": "T3 Idempotency",
        "passed": ok_skip and ok_delete and deleted_from_sp and n_lines == 1,
    }


def test_strict_match() -> dict:
    print("\n=== TEST 5: Strict regex (non-canonical mention is NOT mistaken) ===")
    log_start = log_size()
    title = "_test_strict_match_DELETE_ME"
    tid = make_unscheduled_task(MISC, title)
    print(f"  created {tid} in Misc")
    time.sleep(0.5)
    schedule(tid)
    print(f"  scheduled {tid}")
    time.sleep(WAIT)
    # Pre-write a NON-canonical line that just happens to contain the SP id.
    # The previous loose-match logic would have treated this as proof the
    # entry was already mirrored → silent data loss. The fix should ignore it.
    probe = f"\n<!-- random user note that mentions SP id: {tid} for some reason -->\n"
    with open(BACKLOG_MISC, "a", encoding="utf-8") as f:
        f.write(probe)
    print(f"  pre-wrote non-canonical mention of {tid}")
    unschedule(tid)
    print(f"  unscheduled {tid}")
    time.sleep(WAIT)
    log = read_log_since(log_start)
    # Should NOT log "already mirrored" — it should treat as a normal mirror.
    skipped_wrongly = f"already mirrored, skipping write for {tid}" in log
    if skipped_wrongly:
        print(f"  ✗ listener was fooled by non-canonical mention (loose match)")
    else:
        print(f"  ✓ listener ignored non-canonical mention")
    ok_mirrored = assert_log_has(f"mirrored {tid}", log, "T5 normal mirror")
    deleted_from_sp = not task_exists(tid, MISC)
    n_lines = count_sp_id_lines(BACKLOG_MISC, tid)
    # Expected: 2 occurrences (the user comment + the listener's canonical entry).
    print(f"  occurrences of 'SP id: {tid}' in backlog: {n_lines} (expected 2)")
    # Cleanup: remove probe AND the canonical entry the listener wrote.
    with open(BACKLOG_MISC, "r", encoding="utf-8") as f:
        contents = f.read()
    contents = contents.replace(probe, "")
    # Strip the canonical entry block: the title line + its `> Unscheduled...` line.
    pattern = re.compile(
        rf"\n- {re.escape(title)}\n  > Unscheduled de SP el \d{{4}}-\d{{2}}-\d{{2}}\. SP id: {re.escape(tid)}[^\n]*\n"
    )
    contents = pattern.sub("", contents)
    with open(BACKLOG_MISC, "w", encoding="utf-8") as f:
        f.write(contents)
    print("  cleaned probe + canonical entry")
    return {
        "name": "T5 Strict regex",
        "passed": (not skipped_wrongly) and ok_mirrored and deleted_from_sp and n_lines == 2,
    }


def test_unmapped_project() -> dict:
    print("\n=== TEST 4: Unmapped project (Socio orgas) ===")
    log_start = log_size()
    title = "_test_unmapped_DELETE_ME"
    tid = make_unscheduled_task(SOCIO_ORGAS, title)
    print(f"  created {tid} in Socio orgas")
    time.sleep(0.5)
    schedule(tid)
    print(f"  scheduled {tid}")
    time.sleep(WAIT)
    unschedule(tid)
    print(f"  unscheduled {tid}")
    time.sleep(WAIT)
    log = read_log_since(log_start)
    # Log line is "no backlog mapped for projectId=<id>; task <tid> stays..."
    ok_log = assert_log_has(f"no backlog mapped for projectId={SOCIO_ORGAS}", log, "T4 log")
    ok_stays = task_exists(tid, SOCIO_ORGAS)
    if ok_stays:
        print(f"  ✓ task stays in SP unscheduled")
    else:
        print(f"  ✗ task got deleted (shouldn't have)")
    cleanup(tid)
    return {"name": "T4 Unmapped project", "passed": ok_log and ok_stays}


# Campana propose-20260922-173950: el mirror esta apagado (wiring removido de
# src/index.ts). Estos tests son E2E contra el listener, asi que sin listener no
# hay nada que testear. El guard lee el wiring real en vez de hardcodear
# "apagado", para que re-habilitarlo no requiera volver a editar este archivo.
MIRROR_WIRING_RE = re.compile(r'^\s*socket\.on\("event:taskUpdate"', re.M)
INDEX_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "index.ts")


def mirror_is_registered() -> bool:
    """True si src/index.ts todavia registra el handler event:taskUpdate."""
    try:
        with open(INDEX_TS, encoding="utf-8") as f:
            return bool(MIRROR_WIRING_RE.search(f.read()))
    except OSError:
        # No se pudo leer el wiring: asumimos apagado y saltamos, que es el
        # estado desde 2026-09-22. Forzar con RUN_UNSCHEDULE_MIRROR_TESTS=1.
        return False


def main():
    if not mirror_is_registered() and os.environ.get("RUN_UNSCHEDULE_MIRROR_TESTS") != "1":
        print(
            "SKIP: unschedule-mirror esta DESACTIVADO desde 2026-09-22 "
            "(campaign propose-20260922-173950).\n"
            "      El wiring de src/index.ts fue removido: SP es ahora la unica "
            "fuente del backlog y\n"
            "      desprogramar una tarea ya no la espeja a backlog-<slug>.md ni "
            "la borra de SP.\n"
            "      Estos 5 tests E2E no tienen listener contra el cual correr.\n"
            "      Re-habilitacion: ver el banner de "
            "src/listeners/unschedule-mirror.ts.\n"
            "      Forzar de todos modos: RUN_UNSCHEDULE_MIRROR_TESTS=1 python3 "
            "scripts/test_unschedule_mirror.py"
        )
        sys.exit(0)

    results = []
    results.append(test_inbox_skip())
    results.append(test_resources_skip())
    results.append(test_idempotency())
    results.append(test_unmapped_project())
    results.append(test_strict_match())
    print("\n=== SUMMARY ===")
    for r in results:
        mark = "PASS" if r["passed"] else "FAIL"
        print(f"  [{mark}] {r['name']}")
    total = sum(1 for r in results if r["passed"])
    print(f"\n  {total}/{len(results)} passed")
    sys.exit(0 if total == len(results) else 1)


if __name__ == "__main__":
    main()
