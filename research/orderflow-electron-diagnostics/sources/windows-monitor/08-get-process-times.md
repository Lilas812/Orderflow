Source: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
Title: GetProcessTimes function (processthreadsapi.h) - Win32 apps | Microsoft Learn
Fetched: 2026-10-24T19:32:53.088Z

Table of contents Exit editor mode

Ask LearnAsk Learn

Reading modeTable of contents[Read in English](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)Add to CollectionsAdd to Plans[Edit](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-getprocesstimes.md)

* * *

Copy MarkdownPrint

* * *

Note

Access to this page requires authorization. You can try [signing in](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#) or changing directories.


Access to this page requires authorization. You can try changing directories.


# GetProcessTimes function (processthreadsapi.h)

Feedback

Summarize this article for me


Retrieves timing information for the specified process.

[Section titled: Syntax](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#syntax)

## Syntax

C++

Copy

```cpp
BOOL GetProcessTimes(
  [in]  HANDLE     hProcess,
  [out] LPFILETIME lpCreationTime,
  [out] LPFILETIME lpExitTime,
  [out] LPFILETIME lpKernelTime,
  [out] LPFILETIME lpUserTime
);
```

[Section titled: Parameters](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#parameters)

## Parameters

`[in] hProcess`

A handle to the process whose timing information is sought. The handle must have the **PROCESS\_QUERY\_INFORMATION** or **PROCESS\_QUERY\_LIMITED\_INFORMATION** access right. For more information, see
[Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/desktop/ProcThread/process-security-and-access-rights).

**Windows Server 2003 and Windows XP:** The handle must have the **PROCESS\_QUERY\_INFORMATION** access right.

`[out] lpCreationTime`

A pointer to a
[FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) structure that receives the creation time of the process.

`[out] lpExitTime`

A pointer to a [FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) structure that receives the exit time of the process. If the process has not exited, the content of this structure is undefined.

`[out] lpKernelTime`

A pointer to a
[FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) structure that receives the amount of time that the process has executed in kernel mode. The time that each of the threads of the process has executed in kernel mode is determined, and then all of those times are summed together to obtain this value.

`[out] lpUserTime`

A pointer to a [FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) structure that receives the amount of time that the process has executed in user mode. The time that each of the threads of the process has executed in user mode is determined, and then all of those times are summed together to obtain this value. Note that this value can exceed the amount of real time elapsed (between _lpCreationTime_ and _lpExitTime_) if the process executes across multiple CPU cores.

[Section titled: Return value](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#return-value)

## Return value

If the function succeeds, the return value is nonzero.

If the function fails, the return value is zero. To get extended error information, call
[GetLastError](https://learn.microsoft.com/en-us/windows/desktop/api/errhandlingapi/nf-errhandlingapi-getlasterror).

[Section titled: Remarks](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#remarks)

## Remarks

All times are expressed using [FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) data structures. Such a structure contains two 32-bit values that combine to form a 64-bit count of 100-nanosecond time units.

Process creation and exit times are points in time expressed as the amount of time that has elapsed since midnight on January 1, 1601 at Greenwich, England. There are several functions that an application can use to convert such values to more generally useful forms.

Process kernel mode and user mode times are amounts of time. For example, if a process has spent one second in kernel mode, this function will fill the
[FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime) structure specified by _lpKernelTime_ with a 64-bit value of ten million. That is the number of 100-nanosecond units in one second.

To retrieve the number of CPU clock cycles used by the threads of the process, use the [QueryProcessCycleTime](https://learn.microsoft.com/en-us/windows/desktop/api/realtimeapiset/nf-realtimeapiset-queryprocesscycletime) function.

[Section titled: Requirements](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#requirements)

## Requirements

Expand table

| Requirement | Value |
| --- | --- |
| **Minimum supported client** | Windows XP \[desktop apps \| UWP apps\] |
| **Minimum supported server** | Windows Server 2003 \[desktop apps \| UWP apps\] |
| **Target Platform** | Windows |
| **Header** | processthreadsapi.h (include Windows.h on Windows Server 2003, Windows Vista, Windows 7, Windows Server 2008 Windows Server 2008 R2) |
| **Library** | Kernel32.lib |
| **DLL** | Kernel32.dll |

[Section titled: See also](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#see-also)

## See also

[FILETIME](https://learn.microsoft.com/en-us/windows/desktop/api/minwinbase/ns-minwinbase-filetime)

[FileTimeToDosDateTime](https://learn.microsoft.com/en-us/windows/desktop/api/winbase/nf-winbase-filetimetodosdatetime)

[FileTimeToLocalFileTime](https://learn.microsoft.com/en-us/windows/desktop/api/fileapi/nf-fileapi-filetimetolocalfiletime)

[FileTimeToSystemTime](https://learn.microsoft.com/en-us/windows/desktop/api/timezoneapi/nf-timezoneapi-filetimetosystemtime)

[Process and Thread Functions](https://learn.microsoft.com/en-us/windows/desktop/ProcThread/process-and-thread-functions)

[Processes](https://learn.microsoft.com/en-us/windows/desktop/ProcThread/child-processes)

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

- Last updated on 10/31/2022

Ask Learn is an AI assistant that can answer questions, clarify concepts, and define terms using trusted Microsoft documentation.

Please sign in to use Ask Learn.

[Sign in](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes#)