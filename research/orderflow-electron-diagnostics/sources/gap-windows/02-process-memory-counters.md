Source: https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex
Title: PROCESS_MEMORY_COUNTERS_EX (psapi.h) - Win32 apps | Microsoft Learn
Fetched: 2026-10-24T19:35:06.347Z

Table of contents Exit editor mode

Ask LearnAsk Learn

Reading modeTable of contents[Read in English](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)Add to CollectionsAdd to Plans[Edit](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/psapi/ns-psapi-process_memory_counters_ex.md)

* * *

Copy MarkdownPrint

* * *

Note

Access to this page requires authorization. You can try [signing in](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#) or changing directories.


Access to this page requires authorization. You can try changing directories.


# PROCESS\_MEMORY\_COUNTERS\_EX structure (psapi.h)

Feedback

Summarize this article for me


Contains extended memory statistics for a process.

[Section titled: Syntax](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#syntax)

## Syntax

C++

Copy

```cpp
typedef struct _PROCESS_MEMORY_COUNTERS_EX {
  DWORD  cb;
  DWORD  PageFaultCount;
  SIZE_T PeakWorkingSetSize;
  SIZE_T WorkingSetSize;
  SIZE_T QuotaPeakPagedPoolUsage;
  SIZE_T QuotaPagedPoolUsage;
  SIZE_T QuotaPeakNonPagedPoolUsage;
  SIZE_T QuotaNonPagedPoolUsage;
  SIZE_T PagefileUsage;
  SIZE_T PeakPagefileUsage;
  SIZE_T PrivateUsage;
} PROCESS_MEMORY_COUNTERS_EX;
```

[Section titled: Members](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#members)

## Members

`cb`

The size of the structure, in bytes.

`PageFaultCount`

The number of page faults.

`PeakWorkingSetSize`

The peak working set size, in bytes.

`WorkingSetSize`

The current working set size, in bytes.

`QuotaPeakPagedPoolUsage`

The peak paged pool usage, in bytes.

`QuotaPagedPoolUsage`

The current paged pool usage, in bytes.

`QuotaPeakNonPagedPoolUsage`

The peak nonpaged pool usage, in bytes.

`QuotaNonPagedPoolUsage`

The current nonpaged pool usage, in bytes.

`PagefileUsage`

The Commit Charge value in bytes for this process. Commit Charge is the total amount of private memory that the memory manager has committed for a running process.

**Windows 7 and Windows Server 2008 R2 and earlier:** **PagefileUsage** is always zero. Check **PrivateUsage** instead.

`PeakPagefileUsage`

The peak value in bytes of the Commit Charge during the lifetime of this process.

`PrivateUsage`

Same as **PagefileUsage**. The Commit Charge value in bytes for this process. Commit Charge is the total amount of private memory that the memory manager has committed for a running process.

[Section titled: Requirements](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#requirements)

## Requirements

Expand table

| Requirement | Value |
| --- | --- |
| **Minimum supported client** | Windows Vista, Windows XP with SP2 \[desktop apps only\] |
| **Minimum supported server** | Windows Server 2008, Windows Server 2003 with SP1 \[desktop apps only\] |
| **Header** | psapi.h |

[Section titled: See also](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#see-also)

## See also

[GetProcessMemoryInfo](https://learn.microsoft.com/en-us/windows/desktop/api/psapi/nf-psapi-getprocessmemoryinfo)

[Memory Performance Information](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/aa965225(v=vs.85))

[Process Memory Usage Information](https://learn.microsoft.com/en-us/windows/desktop/psapi/process-memory-usage-information)

[Working Set Information](https://learn.microsoft.com/en-us/windows/desktop/psapi/working-set-information)

Reading mode disabled

* * *

## Feedback

Was this page helpful?


YesNoNo

Need help with this topic?


Want to try using Ask Learn to clarify or guide you through this topic?


Ask LearnAsk Learn

Suggest a fix?

* * *

## Additional resources

* * *

- Last updated on 02/22/2024

Ask Learn is an AI assistant that can answer questions, clarify concepts, and define terms using trusted Microsoft documentation.

Please sign in to use Ask Learn.

[Sign in](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex#)