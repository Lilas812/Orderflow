Source: https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set
Title: Process Working Set - Win32 apps | Microsoft Learn
Fetched: 2026-10-24T19:32:42.152Z

Table of contents Exit editor mode

Ask LearnAsk Learn

Reading modeTable of contents[Read in English](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set)Add to CollectionsAdd to Plans[Edit](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/ProcThread/process-working-set.md)

* * *

Copy MarkdownPrint

* * *

Note

Access to this page requires authorization. You can try [signing in](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set#) or changing directories.


Access to this page requires authorization. You can try changing directories.


# Process Working Set

Feedback

Summarize this article for me


The _working set_ of a program is a collection of those pages in its virtual address space that have been recently referenced. It includes both shared and private data. The shared data includes pages that contain all instructions your application executes, including those in your DLLs and the system DLLs. As the working set size increases, memory demand increases.

A process has an associated minimum working set size and maximum working set size. Each time you call [**CreateProcess**](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa), it reserves the minimum working set size for the process. The virtual memory manager attempts to keep enough memory for the minimum working set resident when the process is active, but keeps no more than the maximum size.

To get the requested minimum and maximum sizes of the working set for your application, call the [**GetProcessWorkingSetSize**](https://learn.microsoft.com/en-us/windows/desktop/api/memoryapi/nf-memoryapi-getprocessworkingsetsize) function.

The system sets the default working set sizes. You can also modify the working set sizes using the [**SetProcessWorkingSetSize**](https://learn.microsoft.com/en-us/windows/desktop/api/memoryapi/nf-memoryapi-setprocessworkingsetsize) function. Setting these values is not a guarantee that the memory will be reserved or resident. Be careful about requesting too large a minimum or maximum working set size, because doing so can degrade system performance.

To obtain the current or peak size of the working set for your process, use the [**GetProcessMemoryInfo**](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo) function.

[Section titled: Related topics](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set#related-topics)

## Related topics

[Memory Performance Information](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/aa965225(v=vs.85))

[Working Set](https://learn.microsoft.com/en-us/windows/win32/memory/working-set)

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

[Sign in](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set#)