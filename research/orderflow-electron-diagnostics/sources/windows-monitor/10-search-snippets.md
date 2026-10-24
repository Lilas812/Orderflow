# Search-result snippets (primary documentation only)

Captured from four webSearch calls; capture date: UNKNOWN. These are search result excerpts, not full page text. Page update dates/version applicability were not present in the excerpts unless stated; mark UNKNOWN rather than infer.

## Job Object assignment
- Title: AssignProcessToJobObject function (jobapi2.h) - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “To create a suspended process, call the CreateProcess function with the CREATE_SUSPENDED flag.” “A process can be associated with more than one job in a hierarchy of nested jobs.”
- Evidence scope: snippet only; no claim here about atomicity, race-free launch, or guaranteed assignment success.

## Nested Jobs
- Title: Nested Jobs - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “AssignProcessToJobObject must be called multiple times for each process to associate the process that does not permit breakaway. If the immediate job...” (snippet truncated).
- Evidence scope: snippet only; full caveats not captured.

## Job Objects general/accounting
- Title: Job Objects - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Date/version: UNKNOWN in snippet.
- Exact excerpts: “To associate a process with a job, use the AssignProcessToJobObject function.” “The job object records basic accounting information for all its associated processes, including those that have terminated.”
- Evidence scope: establishes documented accounting includes terminated processes; exact counter names/query behavior not established by this snippet.

## Process handles and identifiers
- Title: Process Handles and Identifiers - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “The identifier is valid from the time the process is created until the process has been terminated.” Search result further states that these are process handles and can be used with functions that accept process handles.
- Evidence scope: snippet-only; pair with fetched GetProcessTimes page for creation timestamp, not an assumption that PID + time alone is a durable kernel handle.

## Process memory
- Title: GetProcessMemoryInfo function (psapi.h) - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “Retrieves information about the memory usage of the specified process.” “The handle must have the PROCESS_QUERY_INFORMATION or PROCESS_QUERY_LIMITED_INFORMATION access right.”
- Evidence scope: fields and meanings are not in snippet; no direct equivalence to Linux RSS.

## Job memory limits
- Title: JOBOBJECT_EXTENDED_LIMIT_INFORMATION (winnt.h) - Win32 apps | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “If the JOB_OBJECT_LIMIT_JOB_MEMORY value, this member specifies the limit for the virtual memory that can be committed for the job. Otherwise, this member is ignored.”
- Evidence scope: describes a limit and commit; not enough to identify this as a current process memory counter.

## WPR / ETW
- Title: Windows Performance Recorder | Microsoft Learn
- URL: https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder
- Date/version: UNKNOWN in snippet.
- Exact excerpt: “Included in the Windows Assessment and Deployment Kit (Windows ADK), Windows Performance Recorder (WPR) is a performance recording tool that is based on Event Tracing for Windows (ETW). It records system and applic...” (snippet truncated).
- Evidence scope: supports WPR’s ETW basis and ADK packaging only; does not prove a particular profile captures GPU/working-set counters.

## Search query outcome / incomplete evidence
Searches returned official results for GetProcessMemoryInfo and Job Object references, but the excerpts above are not full documentation. One attempted multi-fetch returned HTTP 429; those URLs were not retried. Separate successful fetch evidence is saved in 07-process-working-set.md, 08-get-process-times.md and 09-wait-for-single-object.md.
