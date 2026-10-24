Source: https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr
Title: Introduction to WPR | Microsoft Learn
Fetched: 2026-10-24T19:35:10.335Z

Table of contents Exit editor mode

Ask LearnAsk Learn

Reading modeTable of contents[Read in English](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr)Add to CollectionsAdd to Plans[Edit](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr)

* * *

Copy MarkdownPrint

* * *

Note

Access to this page requires authorization. You can try [signing in](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#) or changing directories.


Access to this page requires authorization. You can try changing directories.


# Introduction to WPR

Feedback

Summarize this article for me


Windows Performance Recorder (WPR) is a tool that extends Event Tracing for Windows (ETW) and provides detailed recordings of system and application behavior and resource usage. You can use WPR together with Windows Performance Analyzer (WPA) to investigate particular areas of performance and to gain an overall understanding of resource consumption. WPR and WPA enable development and IT professionals to proactively identify and resolve performance issues. WPR requires Windows 8 or later version operating system.

[Section titled: WPR Command-Line and User Interface](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#wpr-command-line-and-user-interface)

## WPR Command-Line and User Interface

There are two types of WPR: User Interface (WPRUI.exe) and Command Line Interface (WPR.exe). They both shares the same dll but not all the features are accessible through WPRUI. WPR.exe ships with Windows OS (Windows 8.1 or later) and you do not need additional installation.
The WPR user interface (UI) makes it simple to generate a recording by using built-in recording profiles to analyze CPU usage, power issues, poor system or application performance, or other performance issues.

[Section titled: Recording Profiles](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#recording-profiles)

## Recording Profiles

WPR recording profiles are the lists of event providers to enable a performance recording for a specific scenario. WPR provides a wide selection of built-in recording profiles that are sorted into groups by scenario. For more information about WPR built-in profiles, see [Built-in Recording Profiles](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/built-in-recording-profiles).

You can also author and add custom profiles (.wprp files) in XML to record sets of events and either use them directly using WPR CLI or add them to the list of profiles presented in WPRUI. You can use custom profiles alone or together with built-in profiles or to make specialized recordings that are designed for any usage scenario.For more information about custom profiles, see [Authoring Recording Profiles](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/authoring-recording-profiles) and [Add or Remove a Custom Recording Profile](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-how-to-topics#add-or-remove-a-custom-recording-profile).

[Section titled: Performance Scenarios](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#performance-scenarios)

## Performance Scenarios

You can use performance scenarios to record common scenarios such as the General or [On/Off transitions](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/recording-onoff-transitions) for the system power state based scenarios. You can select only one scenario for a recording. For more information about performance scenarios, see [Performance Scenarios](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/performance-scenarios).

[Section titled: Logging to File or Memory](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#logging-to-file-or-memory)

## Logging to File or Memory

WPR can log events to either a file or to circular buffers in memory. We recommend that you log to file for finite events that can be predicted, such as application start-up or power usage when the computer emerges from a sleep state. File logging is the only logging mode that is available to measure events through on/off transitions.

We recommend that you log to memory for unpredictable events. You can run these recordings for long periods of time without consuming finite memory resources.
For more information about logging modes, see [Logging Mode](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/logging-mode) and [Change the Logging Mode](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-how-to-topics#change-the-logging-mode).

[Section titled: Detail Level](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#detail-level)

## Detail Level

You can select the detail level that fits the scenario: either light or verbose. Light recordings carry less overhead and interfere less with the system (they are sometimes called "timing" recordings). Verbose recordings are more useful for thorough analysis. For more information about detail levels, see [Detail Level](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/detail-level) and [Change the Detail Level](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-how-to-topics#change-the-detail-level).

[Section titled: Related topics](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#related-topics)

## Related topics

[Windows Performance Recorder](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder)

[WPR How-to Topics](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-how-to-topics)

Reading mode disabled

* * *

## Additional resources

* * *

- Last updated on 04/21/2022

Ask Learn is an AI assistant that can answer questions, clarify concepts, and define terms using trusted Microsoft documentation.

Please sign in to use Ask Learn.

[Sign in](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr#)