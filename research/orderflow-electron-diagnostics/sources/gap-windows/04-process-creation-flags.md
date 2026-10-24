Source: https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
Title: Process Creation Flags (WinBase.h) - Win32 apps | Microsoft Learn
Fetched: 2026-10-24T19:35:33.159Z

Table of contents Exit editor mode

Ask LearnAsk Learn

Reading modeTable of contents[Read in English](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)Add to CollectionsAdd to Plans[Edit](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/ProcThread/process-creation-flags.md)

* * *

Copy MarkdownPrint

* * *

Note

Access to this page requires authorization. You can try [signing in](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#) or changing directories.


Access to this page requires authorization. You can try changing directories.


# Process Creation Flags

Feedback

Summarize this article for me


The following process creation flags are used by the [**CreateProcess**](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa), [**CreateProcessAsUser**](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasusera), [**CreateProcessWithLogonW**](https://learn.microsoft.com/en-us/windows/desktop/api/WinBase/nf-winbase-createprocesswithlogonw), and [**CreateProcessWithTokenW**](https://learn.microsoft.com/en-us/windows/desktop/api/WinBase/nf-winbase-createprocesswithtokenw) functions. They can be specified in any combination, except as noted.

[Section titled: Example](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#example)

## Example

C

Copy

```c
     BOOL creationResult;

    creationResult = CreateProcess(
        NULL,                   // No module name (use command line)
        cmdLine,                // Command line
        NULL,                   // Process handle not inheritable
        NULL,                   // Thread handle not inheritable
        FALSE,                  // Set handle inheritance to FALSE
        NORMAL_PRIORITY_CLASS | CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP, // creation flags
        NULL,                   // Use parent's environment block
        NULL,                   // Use parent's starting directory
        &startupInfo,           // Pointer to STARTUPINFO structure
        &processInformation);   // Pointer to PROCESS_INFORMATION structure
```

Example from [Windows classic samples](https://github.com/microsoft/Windows-classic-samples/blob/1d363ff4bd17d8e20415b92e2ee989d615cc0d91/Samples/ManagementInfrastructure/cpp/Process/Provider/WindowsProcess.c) on GitHub.

[Section titled: Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#flags)

## Flags

Expand table

| Constant/value | Description |
| --- | --- |
| **CREATE\_BREAKAWAY\_FROM\_JOB**0x01000000 | The child processes of a process associated with a job are not associated with the job. <br> If the calling process is not associated with a job, this constant has no effect. If the calling process is associated with a job, the job must set the **JOB\_OBJECT\_LIMIT\_BREAKAWAY\_OK** limit. |
| **CREATE\_DEFAULT\_ERROR\_MODE**0x04000000 | The new process does not inherit the error mode of the calling process. Instead, the new process gets the default error mode. <br> This feature is particularly useful for multithreaded shell applications that run with hard errors disabled.<br> The default behavior is for the new process to inherit the error mode of the caller. Setting this flag changes that default behavior. |
| **CREATE\_NEW\_CONSOLE**0x00000010 | The new process has a new console, instead of inheriting its parent's console (the default). For more information, see [Creation of a Console](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console). <br> This flag cannot be used with **DETACHED\_PROCESS**. |
| **CREATE\_NEW\_PROCESS\_GROUP**0x00000200 | The new process is the root process of a new process group. The process group includes all processes that are descendants of this root process. The process identifier of the new process group is the same as the process identifier, which is returned in the _lpProcessInformation_ parameter. Process groups are used by the [**GenerateConsoleCtrlEvent**](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent) function to enable sending a CTRL+BREAK signal to a group of console processes.<br> If this flag is specified, CTRL+C signals will be disabled for all processes within the new process group.<br> This flag is ignored if specified with **CREATE\_NEW\_CONSOLE**. |
| **CREATE\_NO\_WINDOW**0x08000000 | The process is a console application that is being run without a console window. Therefore, the console handle for the application is not set.<br> This flag is ignored if the application is not a console application, or if it is used with either **CREATE\_NEW\_CONSOLE** or **DETACHED\_PROCESS**. |
| **CREATE\_PROTECTED\_PROCESS**0x00040000 | The process is to be run as a protected process. The system restricts access to protected processes and the threads of protected processes. For more information on how processes can interact with protected processes, see [Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights).<br> To activate a protected process, the binary must have a special signature. This signature is provided by Microsoft but not currently available for non-Microsoft binaries. There are currently four protected processes: media foundation, audio engine, Windows error reporting, and system. Components that load into these binaries must also be signed. Multimedia companies can leverage the first two protected processes. For more information, see [Overview of the Protected Media Path](https://learn.microsoft.com/en-us/windows/win32/medfound/protected-media-path).<br>**Windows Server 2003 and Windows XP:** This value is not supported. |
| **CREATE\_PRESERVE\_CODE\_AUTHZ\_LEVEL**0x02000000 | Allows the caller to execute a child process that bypasses the process restrictions that would normally be applied automatically to the process. |
| **CREATE\_SECURE\_PROCESS**0x00400000 | This flag allows secure processes, that run in the Virtualization-Based Security environment, to launch. |
| **CREATE\_SEPARATE\_WOW\_VDM**0x00000800 | This flag is valid only when starting a 16-bit Windows-based application. If set, the new process runs in a private Virtual DOS Machine (VDM). By default, all 16-bit Windows-based applications run as threads in a single, shared VDM. The advantage of running separately is that a crash only terminates the single VDM; any other programs running in distinct VDMs continue to function normally. Also, 16-bit Windows-based applications that are run in separate VDMs have separate input queues. That means that if one application stops responding momentarily, applications in separate VDMs continue to receive input. The disadvantage of running separately is that it takes significantly more memory to do so. You should use this flag only if the user requests that 16-bit applications should run in their own VDM. |
| **CREATE\_SHARED\_WOW\_VDM**0x00001000 | The flag is valid only when starting a 16-bit Windows-based application. If the DefaultSeparateVDM switch in the Windows section of WIN.INI is **TRUE**, this flag overrides the switch. The new process is run in the shared Virtual DOS Machine. |
| **CREATE\_SUSPENDED**0x00000004 | The primary thread of the new process is created in a suspended state, and does not run until the [**ResumeThread**](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread) function is called. |
| **CREATE\_UNICODE\_ENVIRONMENT**0x00000400 | If this flag is set, the environment block pointed to by _lpEnvironment_ uses Unicode characters. Otherwise, the environment block uses ANSI characters. |
| **DEBUG\_ONLY\_THIS\_PROCESS**0x00000002 | The calling thread starts and debugs the new process. It can receive all related debug events using the [**WaitForDebugEvent**](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent) function. |
| **DEBUG\_PROCESS**0x00000001 | The calling thread starts and debugs the new process and all child processes created by the new process. It can receive all related debug events using the [**WaitForDebugEvent**](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent) function. <br> A process that uses **DEBUG\_PROCESS** becomes the root of a debugging chain. This continues until another process in the chain is created with **DEBUG\_PROCESS**.<br> If this flag is combined with **DEBUG\_ONLY\_THIS\_PROCESS**, the caller debugs only the new process, not any child processes. |
| **DETACHED\_PROCESS**0x00000008 | For console processes, the new process does not inherit its parent's console (the default). The new process can call the [**AllocConsole**](https://learn.microsoft.com/en-us/windows/console/allocconsole) function at a later time to create a console. For more information, see [Creation of a Console](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console). <br> This value cannot be used with **CREATE\_NEW\_CONSOLE**. |
| **EXTENDED\_STARTUPINFO\_PRESENT**0x00080000 | The process is created with extended startup information; the _lpStartupInfo_ parameter specifies a [**STARTUPINFOEX**](https://learn.microsoft.com/en-us/windows/desktop/api/WinBase/ns-winbase-startupinfoexa) structure.<br>**Windows Server 2003 and Windows XP:** This value is not supported. |
| **INHERIT\_PARENT\_AFFINITY**0x00010000 | The process inherits its parent's affinity. If the parent process has threads in more than one [processor group](https://learn.microsoft.com/en-us/windows/win32/procthread/processor-groups), the new process inherits the group-relative affinity of an arbitrary group in use by the parent.<br>**Windows Server 2008, Windows Vista, Windows Server 2003 and Windows XP:** This value is not supported. |

[Section titled: Remarks](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#remarks)

## Remarks

On 32-bit Windows, 16-bit applications are simulated by ntvdm.exe, not run as individual processes. Therefore, the process creation flags apply to _ntvdm.exe_. Because ntvdm.exe persists after you run the first 16-bit application, when you launch another 16-bit application, the new creation flags are not applied, except for **CREATE\_NEW\_CONSOLE** and **CREATE\_SEPARATE\_WOW\_VDM**, which create a new ntvdm.exe.

[Section titled: Requirements](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#requirements)

## Requirements

Expand table

| Requirement | Value |
| --- | --- |
| Minimum supported client | Windows XP \[desktop apps only\] |
| Minimum supported server | Windows Server 2003 \[desktop apps only\] |
| Header | WinBase.h (include Windows.h) |

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

- Last updated on 07/14/2025

Ask Learn is an AI assistant that can answer questions, clarify concepts, and define terms using trusted Microsoft documentation.

Please sign in to use Ask Learn.

[Sign in](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#)