## Key Facts
- **VmRSS precision is not a field-presence guarantee.** Linux kernel v6.1 docs say RSS accounting on SMP is asynchronous and “may not be very precise.” They do not say VmRSS can disappear during exit or explain a missing field. This accuracy caveat must not be used to explain the reported absence. [Kernel v6.1 proc docs](https://www.kernel.org/doc/html/v6.1/filesystems/proc.html); saved evidence: `research/orderflow-electron-diagnostics/sources/linux-proc/01-kernel-proc-v6.1.md`.
- The same docs’ documented races concern reads of `/proc/PID/maps` and `/proc/PID/smaps`, especially partial reads while a memory map changes. Its stated map-walk guarantees are not guarantees about `/proc/PID/status` or VmRSS. No retrieved official source establishes that an exit race causes VmRSS omission.
- A plausible mechanism worth investigating—not established as the incident—is that a process being torn down can lose its `mm` while procfs memory reporting is being attempted. The fetched `task_mmu.c` source is a **fixed-revision fork**, and its shown `m_start` branch handles null/unqueuable `mm` for the maps iterator; it does not establish behavior of `task_mem`/`/proc/PID/status`. Do not generalize it to VmRSS. [Source at revision b077…](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs/proc/task_mmu.c); saved evidence: `.../02-task-mmu-source.md`.
- **PID numbers can be reused.** Kernel v6.1 proc documentation search snippet says PID subdirectories do not prevent reuse after exit. A proc directory entry alone is therefore not sufficient identity evidence. [Kernel docs](https://www.kernel.org/doc/html/v6.1/filesystems/proc.html); limited snippet saved in `.../04-search-snippets-limited.md`.
- **pidfd is a stronger process handle once acquired.** The pidfd_open manual describes a pidfd continuing to refer to a terminated zombie without PID recycling only under stated SIGCHLD/SA_NOCLDWAIT/not-reaped conditions; otherwise it recommends creating with `CLONE_PIDFD`. pidfd_open was introduced in Linux 5.3. This does not eliminate a race between learning a numeric PID and opening its pidfd in every acquisition scenario. [pidfd_open(2)](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html); saved evidence: `.../03-man-pidfd-open.md`.
- Search snippets identify VmRSS as the sum of RssAnon, RssFile, and RssShmem, but do not document absence semantics. Retrieved proc_pid_stat snippet did **not** provide the field-22 starttime definition; no starttime guarantee is asserted here.

## Notable Claims Requiring Cross-Reference
- The exit/`mm`-teardown explanation is only a plausible race hypothesis; neither the incident nor VmRSS omission is proven by these sources.
- The v6.1 maps/smaps race documentation cannot be used as evidence for status-file read races.
- The fixed-revision task_mmu source is a fork, not verified mainline; it shows maps-iterator logic, not the status reporting path.

## Source Quality Assessment
Kernel documentation and man-pages are primary technical references; pidfd evidence is from man-pages v6.19 (page says dated 2026-02-08). Kernel proc docs are explicitly v6.1; exact publication dates were not stated. Mainline GitHub task_mmu search snippet is moving `master` with commit/date unknown and incomplete. The fetched Google-hosted source is a fork at a fixed SHA. Snippet-only sources are marked as limited evidence. None verifies compatibility with Electron 45 / Chrome 156 / Node 24 or the application’s Linux/runtime version.

## Gaps / Unanswered Questions
- Need the exact kernel-version `fs/proc/array.c`/status implementation and a mainline `task_mem`/VmRSS path to settle whether/how a null `mm` affects status output versus a read error.
- Need the original incident’s raw status bytes, read result/error, process lifecycle ordering, and identity correlation to call it an observed exit race.
- Need official proc_pid_stat field-22 text and pidfd API/runtime availability for the deployment environment. No source-code or app investigation was performed.

## Sources
1. *The /proc Filesystem* — https://www.kernel.org/doc/html/v6.1/filesystems/proc.html — kernel v6.1; exact date unknown; fetched full evidence, `.../01-kernel-proc-v6.1.md`.
2. *fs/proc/task_mmu.c* — https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs/proc/task_mmu.c — fixed SHA; fork, not mainline; fetched evidence, `.../02-task-mmu-source.md`.
3. *pidfd_open(2)* — https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html — man-pages v6.19, page dated 2026-02-08; fetched evidence, `.../03-man-pidfd-open.md`.
4. *proc_pid_status(5)* — https://man7.org/linux/man-pages/man5/proc_pid_status.5.html — date/version unknown; search snippet only; `.../04-search-snippets-limited.md`.
5. *proc_pid_stat(5)* — https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html — date/version unknown; search snippet only, insufficient for starttime claim; same limited-evidence file.
6. *The /proc Filesystem* — https://docs.kernel.org/filesystems/proc.html — current-docs search snippet; version/date unknown; same limited-evidence file.
7. Mainline `fs/proc/task_mmu.c` — https://github.com/torvalds/linux/blob/master/fs/proc/task_mmu.c — moving branch/date unknown; incomplete search snippet; same limited-evidence file.