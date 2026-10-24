# Linux procfs research: search-result snippets (limited evidence)

Saved from the four webSearch resultPages. These are search snippets, not full-page verification; cite only the text shown here. Search result publication/update dates were not included unless explicitly stated (UNKNOWN).

## proc_pid_status(5) — Linux man-pages project
URL: https://man7.org/linux/man-pages/man5/proc_pid_status.5.html
Date/version: UNKNOWN in snippet.
Snippet: “VmRSS | size of memory portions. It contains the three following parts (VmRSS = RssAnon + RssFile + RssShmem)” (same definition surfaced via kernel documentation search result). The search result identifies the page as “/proc/pid/status - memory usage and status information” and describes PID namespace context. Snippet alone does not establish missing-field behavior or accuracy.

## The /proc Filesystem — Linux kernel documentation (current docs search result)
URL: https://docs.kernel.org/filesystems/proc.html
Date/version: UNKNOWN in search snippet.
Snippet: “For SMP (Symmetric multiprocessing) systems, the information is handled in an asynchronous manner and the value is not very precise.” Search result also presented the three RSS components. This supports imprecision only; it does NOT say VmRSS may be absent, explain field absence, or guarantee behavior during task exit.

## proc_pid_stat(5) — Linux man-pages project
URL: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
Date/version: UNKNOWN in search snippet.
Snippet: Search result identifies “/proc/pid/stat - status information” and says it contains status information about the process; no field-22/starttime definition appeared in the snippet. Do not use this snippet to assert starttime semantics.

## The /proc Filesystem — Linux kernel documentation v6.1 search result
URL: https://www.kernel.org/doc/html/v6.1/filesystems/proc.html
Date/version: v6.1, matching the fetched page; exact publication/update date UNKNOWN in snippet.
Snippet: “subdirectories does not prevent <pid> being reused for some other process in the event that <pid> exits. Operations on open /proc/<pid> file descriptors corresponding” (snippet truncates before completing the latter sentence). Supports PID reuse despite open proc directory entries, but not a full statement of every descriptor operation.

## Linux mainline repository source search result — fs/proc/task_mmu.c
URL: https://github.com/torvalds/linux/blob/master/fs/proc/task_mmu.c
Date/version: branch master is moving; exact commit/date UNKNOWN in snippet.
Snippet: priv->task = get_proc_task(priv->inode); if (!priv->task) return ERR_PTR(-ESRCH); Additional result context showed mm = lock_ctx->mm; but was not a complete task_mem implementation. This is a search excerpt only, insufficient to establish VmRSS behavior. The separately fetched fixed-revision Google-hosted source is a non-mainline fork, noted in its provenance page.

## proc(5) — Linux man-pages project
URL: https://man7.org/linux/man-pages/man5/proc.5.html
Date/version: UNKNOWN in search snippet.
Snippet: Search result identifies this as a general description of /proc and its PID subdirectories; no process-exit race guarantee was shown.
