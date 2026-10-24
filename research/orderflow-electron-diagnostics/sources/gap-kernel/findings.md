Completed the gap-fill research. Saved the complete fetched sources, each with URL/fetch provenance, only under `research/orderflow-electron-diagnostics/sources/gap-kernel/`:
- `linux-v6.18-fs-proc-array.c` — https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/array.c
- `linux-v6.18-kernel-exit.c` — https://raw.githubusercontent.com/torvalds/linux/v6.18/kernel/exit.c
- `linux-v6.18-fs-proc-task_mmu.c` — https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/task_mmu.c

**Verified facts (upstream v6.18 tag):** `proc_pid_status` obtains `mm` with `get_task_mm(task)` and invokes `task_mem(m, mm)` only inside `if (mm)` (array.c upstream lines 437–458). `task_mem` emits `VmRSS` as `total_rss` (task_mmu.c lines 37–78). Thus, if `get_task_mm()` returns NULL, this implementation skips status memory fields; this is not a `/proc/PID/maps` finding.

In `do_exit`, `exit_mm()` is called before `exit_notify()` (exit.c lines 897–982). `exit_mm()` clears `current->mm` at line 575 and releases the mm; `exit_notify()` sets `tsk->exit_state = EXIT_ZOMBIE` at line 749. This supports a **possible transient** after mm detachment and before the zombie transition where status could lack RSS while not yet Z; it does not establish that such a transient caused the original observation. Kernel’s exact field is `EXIT_ZOMBIE`, not `TASK_ZOMBIE`.

`/proc/PID/stat` emits the task start time in the starttime slot: array.c computes it from `task->start_boottime` (lines 584–585) and emits it after fields 1–21 (lines 587–610; field 22 by output order). PID and starttime can therefore help correlate records; no original PID/starttime or captured pidfd/status evidence was provided, so the incident process and any PID reuse cannot be established here.

**Applicability:** these are fixed upstream `v6.18` sources, not a checked `v6.18.58` stable-tree snapshot. Host uname alone does not prove the host’s patched source is identical. The saved files record their fetch timestamp; no claim is made about original A4 kernel version/date or incident cause.