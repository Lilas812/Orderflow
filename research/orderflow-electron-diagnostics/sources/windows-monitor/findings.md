## Key Facts

- **Job assignment / launch ordering:** Microsoft’s `AssignProcessToJobObject` search excerpt explicitly advises creating the process with `CREATE_SUSPENDED`; it also says processes can belong to nested jobs. Creating suspended, assigning, then calling `ResumeThread` is therefore a supported design pattern to avoid running the child before assignment. The evidence captured does **not** establish that assignment always succeeds, nor that this pattern is an atomic launch guarantee. Source: [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), snippet evidence `10-search-snippets.md`.
- **Nested jobs and breakaway:** Microsoft’s nested-jobs result says a process that does not permit breakaway may need multiple `AssignProcessToJobObject` calls to associate through the hierarchy. The search excerpt is truncated; detailed breakaway flags, OS-version behavior, and failure conditions remain unverified here. Source: [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), `10-search-snippets.md`.
- **PID versus handle / creation time:** Microsoft says a process identifier is valid from creation until termination. `GetProcessTimes` documents a process creation timestamp and requires `PROCESS_QUERY_INFORMATION` or `PROCESS_QUERY_LIMITED_INFORMATION`; its exit-time output is undefined while the process is still running. Retaining a process handle is the stronger identity/wait primitive; PID plus creation time is useful for detecting reuse but is not itself a kernel handle. Sources: [Process Handles and Identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers), `10-search-snippets.md`; fetched [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), `08-get-process-times.md`.
- **Wait and handle safety:** `WaitForSingleObject` supports process handles; process termination makes the process object signaled. A pending wait on a handle closed concurrently has undefined behavior. Keep the handle alive for the wait, handle `WAIT_TIMEOUT`/`WAIT_FAILED`, and close only after waiting is complete. Source: fetched [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject), `09-wait-for-single-object.md`.
- **Memory semantics:** Windows working set is recently referenced pages and includes both shared and private data. It is not a private-bytes measure. This establishes why working set cannot be treated as private memory; the gathered sources do not establish equivalence to Linux RSS or a direct cross-platform conversion. Source: fetched [Process Working Set](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set), `07-process-working-set.md` (Microsoft page updated 2025-07-14).
- **Job accounting:** Microsoft’s Job Objects excerpt says basic accounting includes associated processes, including terminated processes. The excerpt is insufficient to specify exact `QueryInformationJobObject` counter semantics or completion-port notification guarantees. Source: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), `10-search-snippets.md`.
- **WPR/ETW:** Microsoft describes WPR as an ETW-based performance recorder included with the Windows ADK. The captured result does not prove which profile captures a given process’s GPU, CPU, or memory counters. Source: [Windows Performance Recorder](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder), `10-search-snippets.md`.

## Notable Claims Requiring Cross-Reference

- Treat “suspended → assign → resume” as a race-reduction pattern, not a guarantee against assignment failure or external job constraints.
- Validate nested-job and breakaway behavior on the target Windows versions and hosting environment; do not assume a child can escape or be assigned identically in every hierarchy.
- Use a retained process handle for liveness/waiting; PID plus creation time is a monitoring correlation check, not a substitute for handle ownership.
- Separate working set, private working set, private commit, and job-wide accounting counters. The evidence gathered does not justify labeling Windows working set as directly equivalent to Linux RSS.
- ETW/WPR is suitable for deeper load-test investigation in principle, but the exact profile and GPU-provider coverage need separate verification.

## Source Quality Assessment

All cited references are primary Microsoft technical documentation. Three pages were fetched and saved with provenance; the remaining official-doc references are search-result excerpts only and have deliberately limited claims. A multi-page fetch attempt returned HTTP 429, so those URLs were not retried. The fetched pages report dates for `GetProcessTimes` (2022-10-31), `WaitForSingleObject` (not returned in the captured answer), and Process Working Set (2025-07-14). Documentation versions are Windows API docs, not evidence specific to Electron 45, Chromium 156, or Node 24.

## Gaps / Unanswered Questions

- Exact `QueryInformationJobObject` accounting classes, current/peak memory field semantics, retention/reset details, and completion-port message ordering/guarantees.
- Exact `GetProcessMemoryInfo` field definitions needed for private bytes versus working-set comparisons.
- Windows-version-specific nested-job/breakaway rules, including exact error cases for the deployment environment.
- WPR profile/provider selection for representative CPU, memory, and GPU load-testing.
- Direct Linux RSS semantic comparison and applicability to the project’s Electron/Chromium/Node versions.

## Sources

1. **AssignProcessToJobObject function** — https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject — date/version UNKNOWN; Windows API docs; search excerpt only; `10-search-snippets.md`.
2. **Nested Jobs** — https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs — date/version UNKNOWN; Windows docs; truncated search excerpt; `10-search-snippets.md`.
3. **Process Handles and Identifiers** — https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers — date/version UNKNOWN; Windows docs; search excerpt only; `10-search-snippets.md`.
4. **GetProcessTimes function** — https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes — updated 2022-10-31; Windows XP / Server 2003 and later per captured docs; fetched evidence `08-get-process-times.md`.
5. **WaitForSingleObject function** — https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject — date UNKNOWN in captured answer; Windows API docs; fetched evidence `09-wait-for-single-object.md`.
6. **Process Working Set** — https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set — updated 2025-07-14; Windows docs; fetched evidence `07-process-working-set.md`.
7. **Job Objects** — https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects — date/version UNKNOWN; Windows docs; search excerpt only; `10-search-snippets.md`.
8. **GetProcessMemoryInfo function** — https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo — date/version UNKNOWN; Windows API docs; search excerpt only; `10-search-snippets.md`.
9. **Windows Performance Recorder** — https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder — date/version UNKNOWN; Windows ADK/WPT docs; search excerpt only; `10-search-snippets.md`.
10. **JOBOBJECT_EXTENDED_LIMIT_INFORMATION** — https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information — date/version UNKNOWN; Windows API docs; search excerpt only; `10-search-snippets.md`.

Only new external research evidence was written under `research/orderflow-electron-diagnostics/sources/windows-monitor/`; no application files or shared notes were changed.