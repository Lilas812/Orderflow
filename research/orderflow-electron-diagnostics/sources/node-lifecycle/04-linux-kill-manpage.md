Source: https://man7.org/linux/man-pages/man2/kill.2.html
Title: kill(2) - Linux manual page
Fetched: 2026-10-24T19:33:18.965Z

|     |     |
| --- | --- |
| [man7.org](https://www.man7.org/index.html) \> Linux > [man-pages](https://www.man7.org/linux/man-pages/index.html) | [Linux/UNIX system programming training](http://man7.org/training/) |

* * *

# kill(2) — Linux manual page

|     |     |
| --- | --- |
| [NAME](https://www.man7.org/linux/man-pages/man2/kill.2.html#NAME) \| [LIBRARY](https://www.man7.org/linux/man-pages/man2/kill.2.html#LIBRARY) \| [SYNOPSIS](https://www.man7.org/linux/man-pages/man2/kill.2.html#SYNOPSIS) \| [DESCRIPTION](https://www.man7.org/linux/man-pages/man2/kill.2.html#DESCRIPTION) \| [RETURN VALUE](https://www.man7.org/linux/man-pages/man2/kill.2.html#RETURN_VALUE) \| [ERRORS](https://www.man7.org/linux/man-pages/man2/kill.2.html#ERRORS) \| [STANDARDS](https://www.man7.org/linux/man-pages/man2/kill.2.html#STANDARDS) \| [HISTORY](https://www.man7.org/linux/man-pages/man2/kill.2.html#HISTORY) \| [NOTES](https://www.man7.org/linux/man-pages/man2/kill.2.html#NOTES) \| [BUGS](https://www.man7.org/linux/man-pages/man2/kill.2.html#BUGS) \| [SEE ALSO](https://www.man7.org/linux/man-pages/man2/kill.2.html#SEE_ALSO) \| [COLOPHON](https://www.man7.org/linux/man-pages/man2/kill.2.html#COLOPHON) |
|  |  |

```
kill(2)                    System Calls Manual                    kill(2)
```

## NAME         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       kill - send signal to a process
```

## LIBRARY         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       Standard C library (libc, -lc)
```

## SYNOPSIS         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       #include <signal.h>

       int kill(pid_t pid, int sig);

   Feature Test Macro Requirements for glibc (see
   feature_test_macros(7)):

       kill():
           _POSIX_C_SOURCE
```

## DESCRIPTION         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       The kill() system call can be used to send any signal to any
       process group or process.

       If pid is positive, then signal sig is sent to the process with
       the ID specified by pid.

       If pid equals 0, then sig is sent to every process in the process
       group of the calling process.

       If pid equals -1, then sig is sent to every process for which the
       calling process has permission to send signals, except for process
       1 (init), but see below.

       If pid is less than -1, then sig is sent to every process in the
       process group whose ID is -pid.

       If sig is 0, then no signal is sent, but existence and permission
       checks are still performed; this can be used to check for the
       existence of a process ID or process group ID that the caller is
       permitted to signal.

       For a process to have permission to send a signal, it must either
       be privileged (under Linux: have the CAP_KILL capability in the
       user namespace of the target process), or the real or effective
       user ID of the sending process must equal the real or saved set-
       user-ID of the target process.  In the case of SIGCONT, it
       suffices when the sending and receiving processes belong to the
       same session.  (Historically, the rules were different; see
       HISTORY.)
```

## RETURN VALUE         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       On success, zero is returned.  If signals were sent to a process
       group, success means that at least one signal was delivered.  On
       error, -1 is returned, and errno is set to indicate the error.
```

## ERRORS         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       EINVAL An invalid signal was specified.

       EPERM  The calling process does not have permission to send the
              signal to any of the target processes.

       ESRCH  The target process or process group does not exist.  Note
              that an existing process might be a zombie, a process that
              has terminated execution, but has not yet been wait(2)ed
              for.
```

## STANDARDS         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       POSIX.1-2024.
```

## HISTORY         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       4.3BSD, SVr4, POSIX.1-1988.

   Linux notes
       Across different kernel versions, Linux has enforced different
       rules for the permissions required for an unprivileged process to
       send a signal to another process.  In Linux 1.0 to 1.2.2, a signal
       could be sent if the effective user ID of the sender matched
       effective user ID of the target, or the real user ID of the sender
       matched the real user ID of the target.  From Linux 1.2.3 until
       1.3.77, a signal could be sent if the effective user ID of the
       sender matched either the real or effective user ID of the target.
       The current rules, which conform to POSIX.1, were adopted in Linux
       1.3.78.
```

## NOTES         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       The only signals that can be sent to process ID 1, the init
       process, are those for which init has explicitly installed signal
       handlers.  This is done to assure the system is not brought down
       accidentally.

       POSIX.1 requires that kill(-1,sig) send sig to all processes that
       the calling process may send signals to, except possibly for some
       implementation-defined system processes.  Linux allows a process
       to signal itself, but on Linux the call kill(-1,sig) does not
       signal the calling process.

       POSIX.1 requires that if a process sends a signal to itself, and
       the sending thread does not have the signal blocked, and no other
       thread has it unblocked or is waiting for it in sigwait(3), at
       least one unblocked signal must be delivered to the sending thread
       before the kill() returns.
```

## BUGS         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       In Linux 2.6 up to and including Linux 2.6.7, there was a bug that
       meant that when sending signals to a process group, kill() failed
       with the error EPERM if the caller did not have permission to send
       the signal to any (rather than all) of the members of the process
       group.  Notwithstanding this error return, the signal was still
       delivered to all of the processes for which the caller had
       permission to signal.
```

## SEE ALSO         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       kill(1), pidfd_send_signal(2), signal(2), tkill(2), _exit(3),
       exit(3), killpg(3), sigqueue(3), capabilities(7), credentials(7),
       signal(7)
```

## COLOPHON         [top](https://www.man7.org/linux/man-pages/man2/kill.2.html\#top_of_page)

```
       This page is part of the man-pages (Linux kernel and C library
       user-space interface documentation) project.  Information about
       the project can be found at
       ⟨https://www.kernel.org/doc/man-pages/⟩.  If you have a bug report
       for this manual page, see
       ⟨https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/tree/CONTRIBUTING⟩.
       This page was obtained from the tarball man-pages-6.19.tar.gz
       fetched from
       ⟨https://mirrors.edge.kernel.org/pub/linux/docs/man-pages/⟩ on
       2026-09-09.  If you discover any rendering problems in this HTML
       version of the page, or you believe there is a better or more up-
       to-date source for the page, or you have corrections or
       improvements to the information in this COLOPHON (which is not
       part of the original manual page), send a mail to
       man-pages@man7.org

Linux man-pages 6.19            2026-06-05                        kill(2)
```

* * *

Pages that refer to this page:
[capsh(1)](https://www.man7.org/linux/man-pages/man1/capsh.1.html),
[fuser(1)](https://www.man7.org/linux/man-pages/man1/fuser.1.html),
[kill(1@@coreutils)](https://www.man7.org/linux/man-pages/man1/kill.1@@coreutils.html),
[kill(1)](https://www.man7.org/linux/man-pages/man1/kill.1.html),
[kill(1@@procps-ng)](https://www.man7.org/linux/man-pages/man1/kill.1@@procps-ng.html),
[killall(1)](https://www.man7.org/linux/man-pages/man1/killall.1.html),
[pgrep(1)](https://www.man7.org/linux/man-pages/man1/pgrep.1.html),
[skill(1)](https://www.man7.org/linux/man-pages/man1/skill.1.html),
[strace(1)](https://www.man7.org/linux/man-pages/man1/strace.1.html),
[clone(2)](https://www.man7.org/linux/man-pages/man2/clone.2.html),
[F\_GETSIG(2const)](https://www.man7.org/linux/man-pages/man2/F_GETSIG.2const.html),
[getpid(2)](https://www.man7.org/linux/man-pages/man2/getpid.2.html),
[getrlimit(2)](https://www.man7.org/linux/man-pages/man2/getrlimit.2.html),
[pause(2)](https://www.man7.org/linux/man-pages/man2/pause.2.html),
[pidfd\_open(2)](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html),
[pidfd\_send\_signal(2)](https://www.man7.org/linux/man-pages/man2/pidfd_send_signal.2.html),
[ptrace(2)](https://www.man7.org/linux/man-pages/man2/ptrace.2.html),
[rt\_sigqueueinfo(2)](https://www.man7.org/linux/man-pages/man2/rt_sigqueueinfo.2.html),
[setfsgid(2)](https://www.man7.org/linux/man-pages/man2/setfsgid.2.html),
[setfsuid(2)](https://www.man7.org/linux/man-pages/man2/setfsuid.2.html),
[sigaction(2)](https://www.man7.org/linux/man-pages/man2/sigaction.2.html),
[signal(2)](https://www.man7.org/linux/man-pages/man2/signal.2.html),
[sigpending(2)](https://www.man7.org/linux/man-pages/man2/sigpending.2.html),
[sigprocmask(2)](https://www.man7.org/linux/man-pages/man2/sigprocmask.2.html),
[sigreturn(2)](https://www.man7.org/linux/man-pages/man2/sigreturn.2.html),
[sigsuspend(2)](https://www.man7.org/linux/man-pages/man2/sigsuspend.2.html),
[sigwaitinfo(2)](https://www.man7.org/linux/man-pages/man2/sigwaitinfo.2.html),
[syscalls(2)](https://www.man7.org/linux/man-pages/man2/syscalls.2.html),
[tkill(2)](https://www.man7.org/linux/man-pages/man2/tkill.2.html),
[wait(2)](https://www.man7.org/linux/man-pages/man2/wait.2.html),
[\_exit(3)](https://www.man7.org/linux/man-pages/man3/_exit.3.html),
[gsignal(3)](https://www.man7.org/linux/man-pages/man3/gsignal.3.html),
[id\_t(3type)](https://www.man7.org/linux/man-pages/man3/id_t.3type.html),
[killpg(3)](https://www.man7.org/linux/man-pages/man3/killpg.3.html),
[psignal(3)](https://www.man7.org/linux/man-pages/man3/psignal.3.html),
[pthread\_kill(3)](https://www.man7.org/linux/man-pages/man3/pthread_kill.3.html),
[raise(3)](https://www.man7.org/linux/man-pages/man3/raise.3.html),
[sd\_event\_add\_child(3)](https://www.man7.org/linux/man-pages/man3/sd_event_add_child.3.html),
[sigpause(3)](https://www.man7.org/linux/man-pages/man3/sigpause.3.html),
[sigqueue(3)](https://www.man7.org/linux/man-pages/man3/sigqueue.3.html),
[sigset(3)](https://www.man7.org/linux/man-pages/man3/sigset.3.html),
[sigvec(3)](https://www.man7.org/linux/man-pages/man3/sigvec.3.html),
[systemd.exec(5)](https://www.man7.org/linux/man-pages/man5/systemd.exec.5.html),
[systemd.kill(5)](https://www.man7.org/linux/man-pages/man5/systemd.kill.5.html),
[capabilities(7)](https://www.man7.org/linux/man-pages/man7/capabilities.7.html),
[cpuset(7)](https://www.man7.org/linux/man-pages/man7/cpuset.7.html),
[credentials(7)](https://www.man7.org/linux/man-pages/man7/credentials.7.html),
[pid\_namespaces(7)](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html),
[pthreads(7)](https://www.man7.org/linux/man-pages/man7/pthreads.7.html),
[rpm-lua(7)](https://www.man7.org/linux/man-pages/man7/rpm-lua.7.html),
[signal(7)](https://www.man7.org/linux/man-pages/man7/signal.7.html),
[signal-safety(7)](https://www.man7.org/linux/man-pages/man7/signal-safety.7.html),
[systemd-coredump(8)](https://www.man7.org/linux/man-pages/man8/systemd-coredump.8.html)

* * *

* * *

* * *