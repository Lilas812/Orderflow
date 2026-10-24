Source: https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs/proc/task_mmu.c
Title: fs/proc/task_mmu.c - pub/scm/linux/kernel/git/sforshee/linux - Git at Google
Fetched: 2026-10-24T19:33:28.601Z

[kernel](https://kernel.googlesource.com/?format=HTML)/ [pub](https://kernel.googlesource.com/pub/)/ [scm](https://kernel.googlesource.com/pub/scm/)/ [linux](https://kernel.googlesource.com/pub/scm/linux/)/ [kernel](https://kernel.googlesource.com/pub/scm/linux/kernel/)/ [git](https://kernel.googlesource.com/pub/scm/linux/kernel/git/)/ [sforshee](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/)/ [linux](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/)/ [b077b7ee9268bb4a34e22a503a2e6315ae8f97a7](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7)/ [.](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/)/ [fs](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs)/ [proc](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs/proc)/task\_mmu.c

blob: ef2eb12906da88c6fe3a227e82598020f0badc44 \[ [file](https://kernel.googlesource.com/pub/scm/linux/kernel/git/sforshee/linux/+/b077b7ee9268bb4a34e22a503a2e6315ae8f97a7/fs/proc/task_mmu.c)\]

|     |     |
| --- | --- |
|  | // SPDX-License-Identifier: GPL-2.0 |
|  | #include<linux/pagewalk.h> |
|  | #include<linux/mm\_inline.h> |
|  | #include<linux/hugetlb.h> |
|  | #include<linux/huge\_mm.h> |
|  | #include<linux/mount.h> |
|  | #include<linux/ksm.h> |
|  | #include<linux/seq\_file.h> |
|  | #include<linux/highmem.h> |
|  | #include<linux/ptrace.h> |
|  | #include<linux/slab.h> |
|  | #include<linux/pagemap.h> |
|  | #include<linux/mempolicy.h> |
|  | #include<linux/rmap.h> |
|  | #include<linux/swap.h> |
|  | #include<linux/sched/mm.h> |
|  | #include<linux/swapops.h> |
|  | #include<linux/mmu\_notifier.h> |
|  | #include<linux/page\_idle.h> |
|  | #include<linux/shmem\_fs.h> |
|  | #include<linux/uaccess.h> |
|  | #include<linux/pkeys.h> |
|  | #include<linux/minmax.h> |
|  | #include<linux/overflow.h> |
|  |  |
|  | #include<asm/elf.h> |
|  | #include<asm/tlb.h> |
|  | #include<asm/tlbflush.h> |
|  | #include"internal.h" |
|  |  |
|  | #define SEQ\_PUT\_DEC(str, val) \ |
|  | seq\_put\_decimal\_ull\_width(m, str,(val)<<(PAGE\_SHIFT-10),8) |
|  | void task\_mem(struct seq\_file \*m,struct mm\_struct \*mm) |
|  | { |
|  | unsignedlong text, lib, swap, anon, file, shmem; |
|  | unsignedlong hiwater\_vm, total\_vm, hiwater\_rss, total\_rss; |
|  |  |
|  | anon = get\_mm\_counter(mm, MM\_ANONPAGES); |
|  | file = get\_mm\_counter(mm, MM\_FILEPAGES); |
|  | shmem = get\_mm\_counter(mm, MM\_SHMEMPAGES); |
|  |  |
|  | /\* |
|  | \\* Note: to minimize their overhead, mm maintains hiwater\_vm and |
|  | \\* hiwater\_rss only when about to \*lower\* total\_vm or rss. Any |
|  | \\* collector of these hiwater stats must therefore get total\_vm |
|  | \\* and rss too, which will usually be the higher. Barriers? not |
|  | \\* worth the effort, such snapshots can always be inconsistent. |
|  | \*/ |
|  | hiwater\_vm = total\_vm = mm->total\_vm; |
|  | if(hiwater\_vm < mm->hiwater\_vm) |
|  | hiwater\_vm = mm->hiwater\_vm; |
|  | hiwater\_rss = total\_rss = anon + file + shmem; |
|  | if(hiwater\_rss < mm->hiwater\_rss) |
|  | hiwater\_rss = mm->hiwater\_rss; |
|  |  |
|  | /\\* split executable areas between text and lib \*/ |
|  | text = PAGE\_ALIGN(mm->end\_code)-(mm->start\_code & PAGE\_MASK); |
|  | text = min(text, mm->exec\_vm << PAGE\_SHIFT); |
|  | lib =(mm->exec\_vm << PAGE\_SHIFT)- text; |
|  |  |
|  | swap = get\_mm\_counter(mm, MM\_SWAPENTS); |
|  | SEQ\_PUT\_DEC("VmPeak:\\t", hiwater\_vm); |
|  | SEQ\_PUT\_DEC(" kB\\nVmSize:\\t", total\_vm); |
|  | SEQ\_PUT\_DEC(" kB\\nVmLck:\\t", mm->locked\_vm); |
|  | SEQ\_PUT\_DEC(" kB\\nVmPin:\\t", atomic64\_read(&mm->pinned\_vm)); |
|  | SEQ\_PUT\_DEC(" kB\\nVmHWM:\\t", hiwater\_rss); |
|  | SEQ\_PUT\_DEC(" kB\\nVmRSS:\\t", total\_rss); |
|  | SEQ\_PUT\_DEC(" kB\\nRssAnon:\\t", anon); |
|  | SEQ\_PUT\_DEC(" kB\\nRssFile:\\t", file); |
|  | SEQ\_PUT\_DEC(" kB\\nRssShmem:\\t", shmem); |
|  | SEQ\_PUT\_DEC(" kB\\nVmData:\\t", mm->data\_vm); |
|  | SEQ\_PUT\_DEC(" kB\\nVmStk:\\t", mm->stack\_vm); |
|  | seq\_put\_decimal\_ull\_width(m, |
|  | " kB\\nVmExe:\\t", text >>10,8); |
|  | seq\_put\_decimal\_ull\_width(m, |
|  | " kB\\nVmLib:\\t", lib >>10,8); |
|  | seq\_put\_decimal\_ull\_width(m, |
|  | " kB\\nVmPTE:\\t", mm\_pgtables\_bytes(mm)>>10,8); |
|  | SEQ\_PUT\_DEC(" kB\\nVmSwap:\\t", swap); |
|  | seq\_puts(m," kB\\n"); |
|  | hugetlb\_report\_usage(m, mm); |
|  | } |
|  | #undef SEQ\_PUT\_DEC |
|  |  |
|  | unsignedlong task\_vsize(struct mm\_struct \*mm) |
|  | { |
|  | return PAGE\_SIZE \* mm->total\_vm; |
|  | } |
|  |  |
|  | unsignedlong task\_statm(struct mm\_struct \*mm, |
|  | unsignedlong\*shared,unsignedlong\*text, |
|  | unsignedlong\*data,unsignedlong\*resident) |
|  | { |
|  | \*shared = get\_mm\_counter(mm, MM\_FILEPAGES)+ |
|  | get\_mm\_counter(mm, MM\_SHMEMPAGES); |
|  | \*text =(PAGE\_ALIGN(mm->end\_code)-(mm->start\_code & PAGE\_MASK)) |
|  | >> PAGE\_SHIFT; |
|  | \*data = mm->data\_vm + mm->stack\_vm; |
|  | \*resident =\*shared + get\_mm\_counter(mm, MM\_ANONPAGES); |
|  | return mm->total\_vm; |
|  | } |
|  |  |
|  | #ifdef CONFIG\_NUMA |
|  | /\* |
|  | \\* Save get\_task\_policy() for show\_numa\_map(). |
|  | \*/ |
|  | staticvoid hold\_task\_mempolicy(struct proc\_maps\_private \*priv) |
|  | { |
|  | struct task\_struct \*task = priv->task; |
|  |  |
|  | task\_lock(task); |
|  | priv->task\_mempolicy = get\_task\_policy(task); |
|  | mpol\_get(priv->task\_mempolicy); |
|  | task\_unlock(task); |
|  | } |
|  | staticvoid release\_task\_mempolicy(struct proc\_maps\_private \*priv) |
|  | { |
|  | mpol\_put(priv->task\_mempolicy); |
|  | } |
|  | #else |
|  | staticvoid hold\_task\_mempolicy(struct proc\_maps\_private \*priv) |
|  | { |
|  | } |
|  | staticvoid release\_task\_mempolicy(struct proc\_maps\_private \*priv) |
|  | { |
|  | } |
|  | #endif |
|  |  |
|  | staticstruct vm\_area\_struct \*proc\_get\_vma(struct proc\_maps\_private \*priv, |
|  | loff\_t\*ppos) |
|  | { |
|  | struct vm\_area\_struct \*vma = vma\_next(&priv->iter); |
|  |  |
|  | if(vma){ |
|  | \*ppos = vma->vm\_start; |
|  | }else{ |
|  | \*ppos =-2UL; |
|  | vma = get\_gate\_vma(priv->mm); |
|  | } |
|  |  |
|  | return vma; |
|  | } |
|  |  |
|  | staticvoid\*m\_start(struct seq\_file \*m,loff\_t\*ppos) |
|  | { |
|  | struct proc\_maps\_private \*priv = m->private; |
|  | unsignedlong last\_addr =\*ppos; |
|  | struct mm\_struct \*mm; |
|  |  |
|  | /\\* See m\_next(). Zero at the start or after lseek. \*/ |
|  | if(last\_addr ==-1UL) |
|  | return NULL; |
|  |  |
|  | priv->task = get\_proc\_task(priv->inode); |
|  | if(!priv->task) |
|  | return ERR\_PTR(-ESRCH); |
|  |  |
|  | mm = priv->mm; |
|  | if(!mm \|\|!mmget\_not\_zero(mm)){ |
|  | put\_task\_struct(priv->task); |
|  | priv->task = NULL; |
|  | return NULL; |
|  | } |
|  |  |
|  | if(mmap\_read\_lock\_killable(mm)){ |
|  | mmput(mm); |
|  | put\_task\_struct(priv->task); |
|  | priv->task = NULL; |
|  | return ERR\_PTR(-EINTR); |
|  | } |
|  |  |
|  | vma\_iter\_init(&priv->iter, mm, last\_addr); |
|  | hold\_task\_mempolicy(priv); |
|  | if(last\_addr ==-2UL) |
|  | return get\_gate\_vma(mm); |
|  |  |
|  | return proc\_get\_vma(priv, ppos); |
|  | } |
|  |  |
|  | staticvoid\*m\_next(struct seq\_file \*m,void\*v,loff\_t\*ppos) |
|  | { |
|  | if(\*ppos ==-2UL){ |
|  | \*ppos =-1UL; |
|  | return NULL; |
|  | } |
|  | return proc\_get\_vma(m->private, ppos); |
|  | } |
|  |  |
|  | staticvoid m\_stop(struct seq\_file \*m,void\*v) |
|  | { |
|  | struct proc\_maps\_private \*priv = m->private; |
|  | struct mm\_struct \*mm = priv->mm; |
|  |  |
|  | if(!priv->task) |
|  | return; |
|  |  |
|  | release\_task\_mempolicy(priv); |
|  | mmap\_read\_unlock(mm); |
|  | mmput(mm); |
|  | put\_task\_struct(priv->task); |
|  | priv->task = NULL; |
|  | } |
|  |  |
|  | staticint proc\_maps\_open(struct inode \*inode,struct file \*file, |
|  | conststruct seq\_operations \*ops,int psize) |
|  | { |
|  | struct proc\_maps\_private \*priv = \_\_seq\_open\_private(file, ops, psize); |
|  |  |
|  | if(!priv) |
|  | return-ENOMEM; |
|  |  |
|  | priv->inode = inode; |
|  | priv->mm = proc\_mem\_open(inode, PTRACE\_MODE\_READ); |
|  | if(IS\_ERR(priv->mm)){ |
|  | int err = PTR\_ERR(priv->mm); |
|  |  |
|  | seq\_release\_private(inode, file); |
|  | return err; |
|  | } |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticint proc\_map\_release(struct inode \*inode,struct file \*file) |
|  | { |
|  | struct seq\_file \*seq = file->private\_data; |
|  | struct proc\_maps\_private \*priv = seq->private; |
|  |  |
|  | if(priv->mm) |
|  | mmdrop(priv->mm); |
|  |  |
|  | return seq\_release\_private(inode, file); |
|  | } |
|  |  |
|  | staticint do\_maps\_open(struct inode \*inode,struct file \*file, |
|  | conststruct seq\_operations \*ops) |
|  | { |
|  | return proc\_maps\_open(inode, file, ops, |
|  | sizeof(struct proc\_maps\_private)); |
|  | } |
|  |  |
|  | staticvoid show\_vma\_header\_prefix(struct seq\_file \*m, |
|  | unsignedlong start,unsignedlong end, |
|  | vm\_flags\_t flags,unsignedlonglong pgoff, |
|  | dev\_t dev,unsignedlong ino) |
|  | { |
|  | seq\_setwidth(m,25+sizeof(void\*)\*6-1); |
|  | seq\_put\_hex\_ll(m, NULL, start,8); |
|  | seq\_put\_hex\_ll(m,"-", end,8); |
|  | seq\_putc(m,' '); |
|  | seq\_putc(m, flags & VM\_READ ?'r':'-'); |
|  | seq\_putc(m, flags & VM\_WRITE ?'w':'-'); |
|  | seq\_putc(m, flags & VM\_EXEC ?'x':'-'); |
|  | seq\_putc(m, flags & VM\_MAYSHARE ?'s':'p'); |
|  | seq\_put\_hex\_ll(m," ", pgoff,8); |
|  | seq\_put\_hex\_ll(m," ", MAJOR(dev),2); |
|  | seq\_put\_hex\_ll(m,":", MINOR(dev),2); |
|  | seq\_put\_decimal\_ull(m," ", ino); |
|  | seq\_putc(m,' '); |
|  | } |
|  |  |
|  | staticvoid |
|  | show\_map\_vma(struct seq\_file \*m,struct vm\_area\_struct \*vma) |
|  | { |
|  | struct anon\_vma\_name \*anon\_name = NULL; |
|  | struct mm\_struct \*mm = vma->vm\_mm; |
|  | struct file \*file = vma->vm\_file; |
|  | vm\_flags\_t flags = vma->vm\_flags; |
|  | unsignedlong ino =0; |
|  | unsignedlonglong pgoff =0; |
|  | unsignedlong start, end; |
|  | dev\_t dev =0; |
|  | constchar\*name = NULL; |
|  |  |
|  | if(file){ |
|  | struct inode \*inode = file\_inode(vma->vm\_file); |
|  | dev = inode->i\_sb->s\_dev; |
|  | ino = inode->i\_ino; |
|  | pgoff =((loff\_t)vma->vm\_pgoff)<< PAGE\_SHIFT; |
|  | } |
|  |  |
|  | start = vma->vm\_start; |
|  | end = vma->vm\_end; |
|  | show\_vma\_header\_prefix(m, start, end, flags, pgoff, dev, ino); |
|  | if(mm) |
|  | anon\_name = anon\_vma\_name(vma); |
|  |  |
|  | /\* |
|  | \\* Print the dentry name for named mappings, and a |
|  | \\* special \[heap\] marker for the heap: |
|  | \*/ |
|  | if(file){ |
|  | seq\_pad(m,' '); |
|  | /\* |
|  | \\* If user named this anon shared memory via |
|  | \\* prctl(PR\_SET\_VMA ..., use the provided name. |
|  | \*/ |
|  | if(anon\_name) |
|  | seq\_printf(m,"\[anon\_shmem:%s\]", anon\_name->name); |
|  | else |
|  | seq\_path(m, file\_user\_path(file),"\\n"); |
|  | goto done; |
|  | } |
|  |  |
|  | if(vma->vm\_ops && vma->vm\_ops->name){ |
|  | name = vma->vm\_ops->name(vma); |
|  | if(name) |
|  | goto done; |
|  | } |
|  |  |
|  | name = arch\_vma\_name(vma); |
|  | if(!name){ |
|  | if(!mm){ |
|  | name ="\[vdso\]"; |
|  | goto done; |
|  | } |
|  |  |
|  | if(vma\_is\_initial\_heap(vma)){ |
|  | name ="\[heap\]"; |
|  | goto done; |
|  | } |
|  |  |
|  | if(vma\_is\_initial\_stack(vma)){ |
|  | name ="\[stack\]"; |
|  | goto done; |
|  | } |
|  |  |
|  | if(anon\_name){ |
|  | seq\_pad(m,' '); |
|  | seq\_printf(m,"\[anon:%s\]", anon\_name->name); |
|  | } |
|  | } |
|  |  |
|  | done: |
|  | if(name){ |
|  | seq\_pad(m,' '); |
|  | seq\_puts(m, name); |
|  | } |
|  | seq\_putc(m,'\\n'); |
|  | } |
|  |  |
|  | staticint show\_map(struct seq\_file \*m,void\*v) |
|  | { |
|  | show\_map\_vma(m, v); |
|  | return0; |
|  | } |
|  |  |
|  | staticconststruct seq\_operations proc\_pid\_maps\_op ={ |
|  | .start = m\_start, |
|  | .next = m\_next, |
|  | .stop = m\_stop, |
|  | .show = show\_map |
|  | }; |
|  |  |
|  | staticint pid\_maps\_open(struct inode \*inode,struct file \*file) |
|  | { |
|  | return do\_maps\_open(inode, file,&proc\_pid\_maps\_op); |
|  | } |
|  |  |
|  | conststruct file\_operations proc\_pid\_maps\_operations ={ |
|  | .open = pid\_maps\_open, |
|  | .read = seq\_read, |
|  | .llseek = seq\_lseek, |
|  | .release = proc\_map\_release, |
|  | }; |
|  |  |
|  | /\* |
|  | \\* Proportional Set Size(PSS): my share of RSS. |
|  | \* |
|  | \\* PSS of a process is the count of pages it has in memory, where each |
|  | \\* page is divided by the number of processes sharing it. So if a |
|  | \\* process has 1000 pages all to itself, and 1000 shared with one other |
|  | \\* process, its PSS will be 1500. |
|  | \* |
|  | \\* To keep (accumulated) division errors low, we adopt a 64bit |
|  | \\* fixed-point pss counter to minimize division errors. So (pss >> |
|  | \\* PSS\_SHIFT) would be the real byte count. |
|  | \* |
|  | \\* A shift of 12 before division means (assuming 4K page size): |
|  | \\* \- 1M 3-user-pages add up to 8KB errors; |
|  | \\* \- supports mapcount up to 2^24, or 16M; |
|  | \\* \- supports PSS up to 2^52 bytes, or 4PB. |
|  | \*/ |
|  | #define PSS\_SHIFT 12 |
|  |  |
|  | #ifdef CONFIG\_PROC\_PAGE\_MONITOR |
|  | struct mem\_size\_stats { |
|  | unsignedlong resident; |
|  | unsignedlong shared\_clean; |
|  | unsignedlong shared\_dirty; |
|  | unsignedlong private\_clean; |
|  | unsignedlong private\_dirty; |
|  | unsignedlong referenced; |
|  | unsignedlong anonymous; |
|  | unsignedlong lazyfree; |
|  | unsignedlong anonymous\_thp; |
|  | unsignedlong shmem\_thp; |
|  | unsignedlong file\_thp; |
|  | unsignedlong swap; |
|  | unsignedlong shared\_hugetlb; |
|  | unsignedlong private\_hugetlb; |
|  | unsignedlong ksm; |
|  | u64 pss; |
|  | u64 pss\_anon; |
|  | u64 pss\_file; |
|  | u64 pss\_shmem; |
|  | u64 pss\_dirty; |
|  | u64 pss\_locked; |
|  | u64 swap\_pss; |
|  | }; |
|  |  |
|  | staticvoid smaps\_page\_accumulate(struct mem\_size\_stats \*mss, |
|  | struct page \*page,unsignedlong size,unsignedlong pss, |
|  | bool dirty,bool locked,boolprivate) |
|  | { |
|  | mss->pss += pss; |
|  |  |
|  | if(PageAnon(page)) |
|  | mss->pss\_anon += pss; |
|  | elseif(PageSwapBacked(page)) |
|  | mss->pss\_shmem += pss; |
|  | else |
|  | mss->pss\_file += pss; |
|  |  |
|  | if(locked) |
|  | mss->pss\_locked += pss; |
|  |  |
|  | if(dirty \|\|PageDirty(page)){ |
|  | mss->pss\_dirty += pss; |
|  | if(private) |
|  | mss->private\_dirty += size; |
|  | else |
|  | mss->shared\_dirty += size; |
|  | }else{ |
|  | if(private) |
|  | mss->private\_clean += size; |
|  | else |
|  | mss->shared\_clean += size; |
|  | } |
|  | } |
|  |  |
|  | staticvoid smaps\_account(struct mem\_size\_stats \*mss,struct page \*page, |
|  | bool compound,bool young,bool dirty,bool locked, |
|  | bool migration) |
|  | { |
|  | int i, nr = compound ? compound\_nr(page):1; |
|  | unsignedlong size = nr \* PAGE\_SIZE; |
|  |  |
|  | /\* |
|  | \\* First accumulate quantities that depend only on \|size\| and the type |
|  | \\* of the compound page. |
|  | \*/ |
|  | if(PageAnon(page)){ |
|  | mss->anonymous += size; |
|  | if(!PageSwapBacked(page)&&!dirty &&!PageDirty(page)) |
|  | mss->lazyfree += size; |
|  | } |
|  |  |
|  | if(PageKsm(page)) |
|  | mss->ksm += size; |
|  |  |
|  | mss->resident += size; |
|  | /\\* Accumulate the size in pages that have been accessed. \*/ |
|  | if(young \|\| page\_is\_young(page)\|\|PageReferenced(page)) |
|  | mss->referenced += size; |
|  |  |
|  | /\* |
|  | \\* Then accumulate quantities that may depend on sharing, or that may |
|  | \\* differ page-by-page. |
|  | \* |
|  | \\* page\_count(page) == 1 guarantees the page is mapped exactly once. |
|  | \\* If any subpage of the compound page mapped with PTE it would elevate |
|  | \\* page\_count(). |
|  | \* |
|  | \\* The page\_mapcount() is called to get a snapshot of the mapcount. |
|  | \\* Without holding the page lock this snapshot can be slightly wrong as |
|  | \\* we cannot always read the mapcount atomically. It is not safe to |
|  | \\* call page\_mapcount() even with PTL held if the page is not mapped, |
|  | \\* especially for migration entries. Treat regular migration entries |
|  | \\* as mapcount == 1. |
|  | \*/ |
|  | if((page\_count(page)==1)\|\| migration){ |
|  | smaps\_page\_accumulate(mss, page, size, size << PSS\_SHIFT, dirty, |
|  | locked,true); |
|  | return; |
|  | } |
|  | for(i =0; i < nr; i++, page++){ |
|  | int mapcount = page\_mapcount(page); |
|  | unsignedlong pss = PAGE\_SIZE << PSS\_SHIFT; |
|  | if(mapcount >=2) |
|  | pss /= mapcount; |
|  | smaps\_page\_accumulate(mss, page, PAGE\_SIZE, pss, dirty, locked, |
|  | mapcount <2); |
|  | } |
|  | } |
|  |  |
|  | #ifdef CONFIG\_SHMEM |
|  | staticint smaps\_pte\_hole(unsignedlong addr,unsignedlong end, |
|  | \_\_always\_unused int depth,struct mm\_walk \*walk) |
|  | { |
|  | struct mem\_size\_stats \*mss = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  |  |
|  | mss->swap += shmem\_partial\_swap\_usage(walk->vma->vm\_file->f\_mapping, |
|  | linear\_page\_index(vma, addr), |
|  | linear\_page\_index(vma, end)); |
|  |  |
|  | return0; |
|  | } |
|  | #else |
|  | #define smaps\_pte\_hole NULL |
|  | #endif/\\* CONFIG\_SHMEM \*/ |
|  |  |
|  | staticvoid smaps\_pte\_hole\_lookup(unsignedlong addr,struct mm\_walk \*walk) |
|  | { |
|  | #ifdef CONFIG\_SHMEM |
|  | if(walk->ops->pte\_hole){ |
|  | /\\* depth is not used \*/ |
|  | smaps\_pte\_hole(addr, addr + PAGE\_SIZE,0, walk); |
|  | } |
|  | #endif |
|  | } |
|  |  |
|  | staticvoid smaps\_pte\_entry(pte\_t\*pte,unsignedlong addr, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct mem\_size\_stats \*mss = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | bool locked =!!(vma->vm\_flags & VM\_LOCKED); |
|  | struct page \*page = NULL; |
|  | bool migration =false, young =false, dirty =false; |
|  | pte\_t ptent = ptep\_get(pte); |
|  |  |
|  | if(pte\_present(ptent)){ |
|  | page = vm\_normal\_page(vma, addr, ptent); |
|  | young = pte\_young(ptent); |
|  | dirty = pte\_dirty(ptent); |
|  | }elseif(is\_swap\_pte(ptent)){ |
|  | swp\_entry\_t swpent = pte\_to\_swp\_entry(ptent); |
|  |  |
|  | if(!non\_swap\_entry(swpent)){ |
|  | int mapcount; |
|  |  |
|  | mss->swap += PAGE\_SIZE; |
|  | mapcount = swp\_swapcount(swpent); |
|  | if(mapcount >=2){ |
|  | u64 pss\_delta =(u64)PAGE\_SIZE << PSS\_SHIFT; |
|  |  |
|  | do\_div(pss\_delta, mapcount); |
|  | mss->swap\_pss += pss\_delta; |
|  | }else{ |
|  | mss->swap\_pss +=(u64)PAGE\_SIZE << PSS\_SHIFT; |
|  | } |
|  | }elseif(is\_pfn\_swap\_entry(swpent)){ |
|  | if(is\_migration\_entry(swpent)) |
|  | migration =true; |
|  | page = pfn\_swap\_entry\_to\_page(swpent); |
|  | } |
|  | }else{ |
|  | smaps\_pte\_hole\_lookup(addr, walk); |
|  | return; |
|  | } |
|  |  |
|  | if(!page) |
|  | return; |
|  |  |
|  | smaps\_account(mss, page,false, young, dirty, locked, migration); |
|  | } |
|  |  |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | staticvoid smaps\_pmd\_entry(pmd\_t\*pmd,unsignedlong addr, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct mem\_size\_stats \*mss = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | bool locked =!!(vma->vm\_flags & VM\_LOCKED); |
|  | struct page \*page = NULL; |
|  | bool migration =false; |
|  |  |
|  | if(pmd\_present(\*pmd)){ |
|  | page = vm\_normal\_page\_pmd(vma, addr,\*pmd); |
|  | }elseif(unlikely(thp\_migration\_supported()&& is\_swap\_pmd(\*pmd))){ |
|  | swp\_entry\_t entry = pmd\_to\_swp\_entry(\*pmd); |
|  |  |
|  | if(is\_migration\_entry(entry)){ |
|  | migration =true; |
|  | page = pfn\_swap\_entry\_to\_page(entry); |
|  | } |
|  | } |
|  | if(IS\_ERR\_OR\_NULL(page)) |
|  | return; |
|  | if(PageAnon(page)) |
|  | mss->anonymous\_thp += HPAGE\_PMD\_SIZE; |
|  | elseif(PageSwapBacked(page)) |
|  | mss->shmem\_thp += HPAGE\_PMD\_SIZE; |
|  | elseif(is\_zone\_device\_page(page)) |
|  | /\\* pass \*/; |
|  | else |
|  | mss->file\_thp += HPAGE\_PMD\_SIZE; |
|  |  |
|  | smaps\_account(mss, page,true, pmd\_young(\*pmd), pmd\_dirty(\*pmd), |
|  | locked, migration); |
|  | } |
|  | #else |
|  | staticvoid smaps\_pmd\_entry(pmd\_t\*pmd,unsignedlong addr, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | } |
|  | #endif |
|  |  |
|  | staticint smaps\_pte\_range(pmd\_t\*pmd,unsignedlong addr,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | pte\_t\*pte; |
|  | spinlock\_t\*ptl; |
|  |  |
|  | ptl = pmd\_trans\_huge\_lock(pmd, vma); |
|  | if(ptl){ |
|  | smaps\_pmd\_entry(pmd, addr, walk); |
|  | spin\_unlock(ptl); |
|  | goto out; |
|  | } |
|  |  |
|  | pte = pte\_offset\_map\_lock(vma->vm\_mm, pmd, addr,&ptl); |
|  | if(!pte){ |
|  | walk->action = ACTION\_AGAIN; |
|  | return0; |
|  | } |
|  | for(; addr != end; pte++, addr += PAGE\_SIZE) |
|  | smaps\_pte\_entry(pte, addr, walk); |
|  | pte\_unmap\_unlock(pte -1, ptl); |
|  | out: |
|  | cond\_resched(); |
|  | return0; |
|  | } |
|  |  |
|  | staticvoid show\_smap\_vma\_flags(struct seq\_file \*m,struct vm\_area\_struct \*vma) |
|  | { |
|  | /\* |
|  | \\* Don't forget to update Documentation/ on changes. |
|  | \*/ |
|  | staticconstchar mnemonics\[BITS\_PER\_LONG\]\[2\]={ |
|  | /\* |
|  | \\* In case if we meet a flag we don't know about. |
|  | \*/ |
|  | \[0...(BITS\_PER\_LONG-1)\]="??", |
|  |  |
|  | \[ilog2(VM\_READ)\]="rd", |
|  | \[ilog2(VM\_WRITE)\]="wr", |
|  | \[ilog2(VM\_EXEC)\]="ex", |
|  | \[ilog2(VM\_SHARED)\]="sh", |
|  | \[ilog2(VM\_MAYREAD)\]="mr", |
|  | \[ilog2(VM\_MAYWRITE)\]="mw", |
|  | \[ilog2(VM\_MAYEXEC)\]="me", |
|  | \[ilog2(VM\_MAYSHARE)\]="ms", |
|  | \[ilog2(VM\_GROWSDOWN)\]="gd", |
|  | \[ilog2(VM\_PFNMAP)\]="pf", |
|  | \[ilog2(VM\_LOCKED)\]="lo", |
|  | \[ilog2(VM\_IO)\]="io", |
|  | \[ilog2(VM\_SEQ\_READ)\]="sr", |
|  | \[ilog2(VM\_RAND\_READ)\]="rr", |
|  | \[ilog2(VM\_DONTCOPY)\]="dc", |
|  | \[ilog2(VM\_DONTEXPAND)\]="de", |
|  | \[ilog2(VM\_LOCKONFAULT)\]="lf", |
|  | \[ilog2(VM\_ACCOUNT)\]="ac", |
|  | \[ilog2(VM\_NORESERVE)\]="nr", |
|  | \[ilog2(VM\_HUGETLB)\]="ht", |
|  | \[ilog2(VM\_SYNC)\]="sf", |
|  | \[ilog2(VM\_ARCH\_1)\]="ar", |
|  | \[ilog2(VM\_WIPEONFORK)\]="wf", |
|  | \[ilog2(VM\_DONTDUMP)\]="dd", |
|  | #ifdef CONFIG\_ARM64\_BTI |
|  | \[ilog2(VM\_ARM64\_BTI)\]="bt", |
|  | #endif |
|  | #ifdef CONFIG\_MEM\_SOFT\_DIRTY |
|  | \[ilog2(VM\_SOFTDIRTY)\]="sd", |
|  | #endif |
|  | \[ilog2(VM\_MIXEDMAP)\]="mm", |
|  | \[ilog2(VM\_HUGEPAGE)\]="hg", |
|  | \[ilog2(VM\_NOHUGEPAGE)\]="nh", |
|  | \[ilog2(VM\_MERGEABLE)\]="mg", |
|  | \[ilog2(VM\_UFFD\_MISSING)\]="um", |
|  | \[ilog2(VM\_UFFD\_WP)\]="uw", |
|  | #ifdef CONFIG\_ARM64\_MTE |
|  | \[ilog2(VM\_MTE)\]="mt", |
|  | \[ilog2(VM\_MTE\_ALLOWED)\]="", |
|  | #endif |
|  | #ifdef CONFIG\_ARCH\_HAS\_PKEYS |
|  | /\\* These come out via ProtectionKey: \*/ |
|  | \[ilog2(VM\_PKEY\_BIT0)\]="", |
|  | \[ilog2(VM\_PKEY\_BIT1)\]="", |
|  | \[ilog2(VM\_PKEY\_BIT2)\]="", |
|  | \[ilog2(VM\_PKEY\_BIT3)\]="", |
|  | #if VM\_PKEY\_BIT4 |
|  | \[ilog2(VM\_PKEY\_BIT4)\]="", |
|  | #endif |
|  | #endif/\\* CONFIG\_ARCH\_HAS\_PKEYS \*/ |
|  | #ifdef CONFIG\_HAVE\_ARCH\_USERFAULTFD\_MINOR |
|  | \[ilog2(VM\_UFFD\_MINOR)\]="ui", |
|  | #endif/\\* CONFIG\_HAVE\_ARCH\_USERFAULTFD\_MINOR \*/ |
|  | #ifdef CONFIG\_X86\_USER\_SHADOW\_STACK |
|  | \[ilog2(VM\_SHADOW\_STACK)\]="ss", |
|  | #endif |
|  | }; |
|  | size\_t i; |
|  |  |
|  | seq\_puts(m,"VmFlags: "); |
|  | for(i =0; i < BITS\_PER\_LONG; i++){ |
|  | if(!mnemonics\[i\]\[0\]) |
|  | continue; |
|  | if(vma->vm\_flags &(1UL<< i)){ |
|  | seq\_putc(m, mnemonics\[i\]\[0\]); |
|  | seq\_putc(m, mnemonics\[i\]\[1\]); |
|  | seq\_putc(m,' '); |
|  | } |
|  | } |
|  | seq\_putc(m,'\\n'); |
|  | } |
|  |  |
|  | #ifdef CONFIG\_HUGETLB\_PAGE |
|  | staticint smaps\_hugetlb\_range(pte\_t\*pte,unsignedlong hmask, |
|  | unsignedlong addr,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct mem\_size\_stats \*mss = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | struct page \*page = NULL; |
|  | pte\_t ptent = ptep\_get(pte); |
|  |  |
|  | if(pte\_present(ptent)){ |
|  | page = vm\_normal\_page(vma, addr, ptent); |
|  | }elseif(is\_swap\_pte(ptent)){ |
|  | swp\_entry\_t swpent = pte\_to\_swp\_entry(ptent); |
|  |  |
|  | if(is\_pfn\_swap\_entry(swpent)) |
|  | page = pfn\_swap\_entry\_to\_page(swpent); |
|  | } |
|  | if(page){ |
|  | if(page\_mapcount(page)>=2\|\| hugetlb\_pmd\_shared(pte)) |
|  | mss->shared\_hugetlb += huge\_page\_size(hstate\_vma(vma)); |
|  | else |
|  | mss->private\_hugetlb += huge\_page\_size(hstate\_vma(vma)); |
|  | } |
|  | return0; |
|  | } |
|  | #else |
|  | #define smaps\_hugetlb\_range NULL |
|  | #endif/\\* HUGETLB\_PAGE \*/ |
|  |  |
|  | staticconststruct mm\_walk\_ops smaps\_walk\_ops ={ |
|  | .pmd\_entry = smaps\_pte\_range, |
|  | .hugetlb\_entry = smaps\_hugetlb\_range, |
|  | .walk\_lock = PGWALK\_RDLOCK, |
|  | }; |
|  |  |
|  | staticconststruct mm\_walk\_ops smaps\_shmem\_walk\_ops ={ |
|  | .pmd\_entry = smaps\_pte\_range, |
|  | .hugetlb\_entry = smaps\_hugetlb\_range, |
|  | .pte\_hole = smaps\_pte\_hole, |
|  | .walk\_lock = PGWALK\_RDLOCK, |
|  | }; |
|  |  |
|  | /\* |
|  | \\* Gather mem stats from @vma with the indicated beginning |
|  | \\* address @start, and keep them in @mss. |
|  | \* |
|  | \\* Use vm\_start of @vma as the beginning address if @start is 0. |
|  | \*/ |
|  | staticvoid smap\_gather\_stats(struct vm\_area\_struct \*vma, |
|  | struct mem\_size\_stats \*mss,unsignedlong start) |
|  | { |
|  | conststruct mm\_walk\_ops \*ops =&smaps\_walk\_ops; |
|  |  |
|  | /\\* Invalid start \*/ |
|  | if(start >= vma->vm\_end) |
|  | return; |
|  |  |
|  | if(vma->vm\_file && shmem\_mapping(vma->vm\_file->f\_mapping)){ |
|  | /\* |
|  | \\* For shared or readonly shmem mappings we know that all |
|  | \\* swapped out pages belong to the shmem object, and we can |
|  | \\* obtain the swap value much more efficiently. For private |
|  | \\* writable mappings, we might have COW pages that are |
|  | \\* not affected by the parent swapped out pages of the shmem |
|  | \\* object, so we have to distinguish them during the page walk. |
|  | \\* Unless we know that the shmem object (or the part mapped by |
|  | \\* our VMA) has no swapped out pages at all. |
|  | \*/ |
|  | unsignedlong shmem\_swapped = shmem\_swap\_usage(vma); |
|  |  |
|  | if(!start &&(!shmem\_swapped \|\|(vma->vm\_flags & VM\_SHARED)\|\| |
|  | !(vma->vm\_flags & VM\_WRITE))){ |
|  | mss->swap += shmem\_swapped; |
|  | }else{ |
|  | ops =&smaps\_shmem\_walk\_ops; |
|  | } |
|  | } |
|  |  |
|  | /\\* mmap\_lock is held in m\_start \*/ |
|  | if(!start) |
|  | walk\_page\_vma(vma, ops, mss); |
|  | else |
|  | walk\_page\_range(vma->vm\_mm, start, vma->vm\_end, ops, mss); |
|  | } |
|  |  |
|  | #define SEQ\_PUT\_DEC(str, val) \ |
|  | seq\_put\_decimal\_ull\_width(m, str,(val)>>10,8) |
|  |  |
|  | /\\* Show the contents common for smaps and smaps\_rollup \*/ |
|  | staticvoid \_\_show\_smap(struct seq\_file \*m,conststruct mem\_size\_stats \*mss, |
|  | bool rollup\_mode) |
|  | { |
|  | SEQ\_PUT\_DEC("Rss: ", mss->resident); |
|  | SEQ\_PUT\_DEC(" kB\\nPss: ", mss->pss >> PSS\_SHIFT); |
|  | SEQ\_PUT\_DEC(" kB\\nPss\_Dirty: ", mss->pss\_dirty >> PSS\_SHIFT); |
|  | if(rollup\_mode){ |
|  | /\* |
|  | \\* These are meaningful only for smaps\_rollup, otherwise two of |
|  | \\* them are zero, and the other one is the same as Pss. |
|  | \*/ |
|  | SEQ\_PUT\_DEC(" kB\\nPss\_Anon: ", |
|  | mss->pss\_anon >> PSS\_SHIFT); |
|  | SEQ\_PUT\_DEC(" kB\\nPss\_File: ", |
|  | mss->pss\_file >> PSS\_SHIFT); |
|  | SEQ\_PUT\_DEC(" kB\\nPss\_Shmem: ", |
|  | mss->pss\_shmem >> PSS\_SHIFT); |
|  | } |
|  | SEQ\_PUT\_DEC(" kB\\nShared\_Clean: ", mss->shared\_clean); |
|  | SEQ\_PUT\_DEC(" kB\\nShared\_Dirty: ", mss->shared\_dirty); |
|  | SEQ\_PUT\_DEC(" kB\\nPrivate\_Clean: ", mss->private\_clean); |
|  | SEQ\_PUT\_DEC(" kB\\nPrivate\_Dirty: ", mss->private\_dirty); |
|  | SEQ\_PUT\_DEC(" kB\\nReferenced: ", mss->referenced); |
|  | SEQ\_PUT\_DEC(" kB\\nAnonymous: ", mss->anonymous); |
|  | SEQ\_PUT\_DEC(" kB\\nKSM: ", mss->ksm); |
|  | SEQ\_PUT\_DEC(" kB\\nLazyFree: ", mss->lazyfree); |
|  | SEQ\_PUT\_DEC(" kB\\nAnonHugePages: ", mss->anonymous\_thp); |
|  | SEQ\_PUT\_DEC(" kB\\nShmemPmdMapped: ", mss->shmem\_thp); |
|  | SEQ\_PUT\_DEC(" kB\\nFilePmdMapped: ", mss->file\_thp); |
|  | SEQ\_PUT\_DEC(" kB\\nShared\_Hugetlb: ", mss->shared\_hugetlb); |
|  | seq\_put\_decimal\_ull\_width(m," kB\\nPrivate\_Hugetlb: ", |
|  | mss->private\_hugetlb >>10,7); |
|  | SEQ\_PUT\_DEC(" kB\\nSwap: ", mss->swap); |
|  | SEQ\_PUT\_DEC(" kB\\nSwapPss: ", |
|  | mss->swap\_pss >> PSS\_SHIFT); |
|  | SEQ\_PUT\_DEC(" kB\\nLocked: ", |
|  | mss->pss\_locked >> PSS\_SHIFT); |
|  | seq\_puts(m," kB\\n"); |
|  | } |
|  |  |
|  | staticint show\_smap(struct seq\_file \*m,void\*v) |
|  | { |
|  | struct vm\_area\_struct \*vma = v; |
|  | struct mem\_size\_stats mss ={}; |
|  |  |
|  | smap\_gather\_stats(vma,&mss,0); |
|  |  |
|  | show\_map\_vma(m, vma); |
|  |  |
|  | SEQ\_PUT\_DEC("Size: ", vma->vm\_end - vma->vm\_start); |
|  | SEQ\_PUT\_DEC(" kB\\nKernelPageSize: ", vma\_kernel\_pagesize(vma)); |
|  | SEQ\_PUT\_DEC(" kB\\nMMUPageSize: ", vma\_mmu\_pagesize(vma)); |
|  | seq\_puts(m," kB\\n"); |
|  |  |
|  | \_\_show\_smap(m,&mss,false); |
|  |  |
|  | seq\_printf(m,"THPeligible: %8u\\n", |
|  | hugepage\_vma\_check(vma, vma->vm\_flags,true,false,true)); |
|  |  |
|  | if(arch\_pkeys\_enabled()) |
|  | seq\_printf(m,"ProtectionKey: %8u\\n", vma\_pkey(vma)); |
|  | show\_smap\_vma\_flags(m, vma); |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticint show\_smaps\_rollup(struct seq\_file \*m,void\*v) |
|  | { |
|  | struct proc\_maps\_private \*priv = m->private; |
|  | struct mem\_size\_stats mss ={}; |
|  | struct mm\_struct \*mm = priv->mm; |
|  | struct vm\_area\_struct \*vma; |
|  | unsignedlong vma\_start =0, last\_vma\_end =0; |
|  | int ret =0; |
|  | VMA\_ITERATOR(vmi, mm,0); |
|  |  |
|  | priv->task = get\_proc\_task(priv->inode); |
|  | if(!priv->task) |
|  | return-ESRCH; |
|  |  |
|  | if(!mm \|\|!mmget\_not\_zero(mm)){ |
|  | ret =-ESRCH; |
|  | goto out\_put\_task; |
|  | } |
|  |  |
|  | ret = mmap\_read\_lock\_killable(mm); |
|  | if(ret) |
|  | goto out\_put\_mm; |
|  |  |
|  | hold\_task\_mempolicy(priv); |
|  | vma = vma\_next(&vmi); |
|  |  |
|  | if(unlikely(!vma)) |
|  | goto empty\_set; |
|  |  |
|  | vma\_start = vma->vm\_start; |
|  | do{ |
|  | smap\_gather\_stats(vma,&mss,0); |
|  | last\_vma\_end = vma->vm\_end; |
|  |  |
|  | /\* |
|  | \\* Release mmap\_lock temporarily if someone wants to |
|  | \\* access it for write request. |
|  | \*/ |
|  | if(mmap\_lock\_is\_contended(mm)){ |
|  | vma\_iter\_invalidate(&vmi); |
|  | mmap\_read\_unlock(mm); |
|  | ret = mmap\_read\_lock\_killable(mm); |
|  | if(ret){ |
|  | release\_task\_mempolicy(priv); |
|  | goto out\_put\_mm; |
|  | } |
|  |  |
|  | /\* |
|  | \\* After dropping the lock, there are four cases to |
|  | \\* consider. See the following example for explanation. |
|  | \* |
|  | \\* +------+------+-----------+ |
|  | \\* \| VMA1 \| VMA2 \| VMA3 \| |
|  | \\* +------+------+-----------+ |
|  | \\* \| \| \| \| |
|  | \\* 4k 8k 16k 400k |
|  | \* |
|  | \\* Suppose we drop the lock after reading VMA2 due to |
|  | \\* contention, then we get: |
|  | \* |
|  | \\* last\_vma\_end = 16k |
|  | \* |
|  | \\* 1) VMA2 is freed, but VMA3 exists: |
|  | \* |
|  | \\* vma\_next(vmi) will return VMA3. |
|  | \\* In this case, just continue from VMA3. |
|  | \* |
|  | \\* 2) VMA2 still exists: |
|  | \* |
|  | \\* vma\_next(vmi) will return VMA3. |
|  | \\* In this case, just continue from VMA3. |
|  | \* |
|  | \\* 3) No more VMAs can be found: |
|  | \* |
|  | \\* vma\_next(vmi) will return NULL. |
|  | \\* No more things to do, just break. |
|  | \* |
|  | \\* 4) (last\_vma\_end - 1) is the middle of a vma (VMA'): |
|  | \* |
|  | \\* vma\_next(vmi) will return VMA' whose range |
|  | \\* contains last\_vma\_end. |
|  | \\* Iterate VMA' from last\_vma\_end. |
|  | \*/ |
|  | vma = vma\_next(&vmi); |
|  | /\\* Case 3 above \*/ |
|  | if(!vma) |
|  | break; |
|  |  |
|  | /\\* Case 1 and 2 above \*/ |
|  | if(vma->vm\_start >= last\_vma\_end) |
|  | continue; |
|  |  |
|  | /\\* Case 4 above \*/ |
|  | if(vma->vm\_end > last\_vma\_end) |
|  | smap\_gather\_stats(vma,&mss, last\_vma\_end); |
|  | } |
|  | } for\_each\_vma(vmi, vma); |
|  |  |
|  | empty\_set: |
|  | show\_vma\_header\_prefix(m, vma\_start, last\_vma\_end,0,0,0,0); |
|  | seq\_pad(m,' '); |
|  | seq\_puts(m,"\[rollup\]\\n"); |
|  |  |
|  | \_\_show\_smap(m,&mss,true); |
|  |  |
|  | release\_task\_mempolicy(priv); |
|  | mmap\_read\_unlock(mm); |
|  |  |
|  | out\_put\_mm: |
|  | mmput(mm); |
|  | out\_put\_task: |
|  | put\_task\_struct(priv->task); |
|  | priv->task = NULL; |
|  |  |
|  | return ret; |
|  | } |
|  | #undef SEQ\_PUT\_DEC |
|  |  |
|  | staticconststruct seq\_operations proc\_pid\_smaps\_op ={ |
|  | .start = m\_start, |
|  | .next = m\_next, |
|  | .stop = m\_stop, |
|  | .show = show\_smap |
|  | }; |
|  |  |
|  | staticint pid\_smaps\_open(struct inode \*inode,struct file \*file) |
|  | { |
|  | return do\_maps\_open(inode, file,&proc\_pid\_smaps\_op); |
|  | } |
|  |  |
|  | staticint smaps\_rollup\_open(struct inode \*inode,struct file \*file) |
|  | { |
|  | int ret; |
|  | struct proc\_maps\_private \*priv; |
|  |  |
|  | priv = kzalloc(sizeof(\*priv), GFP\_KERNEL\_ACCOUNT); |
|  | if(!priv) |
|  | return-ENOMEM; |
|  |  |
|  | ret = single\_open(file, show\_smaps\_rollup, priv); |
|  | if(ret) |
|  | goto out\_free; |
|  |  |
|  | priv->inode = inode; |
|  | priv->mm = proc\_mem\_open(inode, PTRACE\_MODE\_READ); |
|  | if(IS\_ERR(priv->mm)){ |
|  | ret = PTR\_ERR(priv->mm); |
|  |  |
|  | single\_release(inode, file); |
|  | goto out\_free; |
|  | } |
|  |  |
|  | return0; |
|  |  |
|  | out\_free: |
|  | kfree(priv); |
|  | return ret; |
|  | } |
|  |  |
|  | staticint smaps\_rollup\_release(struct inode \*inode,struct file \*file) |
|  | { |
|  | struct seq\_file \*seq = file->private\_data; |
|  | struct proc\_maps\_private \*priv = seq->private; |
|  |  |
|  | if(priv->mm) |
|  | mmdrop(priv->mm); |
|  |  |
|  | kfree(priv); |
|  | return single\_release(inode, file); |
|  | } |
|  |  |
|  | conststruct file\_operations proc\_pid\_smaps\_operations ={ |
|  | .open = pid\_smaps\_open, |
|  | .read = seq\_read, |
|  | .llseek = seq\_lseek, |
|  | .release = proc\_map\_release, |
|  | }; |
|  |  |
|  | conststruct file\_operations proc\_pid\_smaps\_rollup\_operations ={ |
|  | .open = smaps\_rollup\_open, |
|  | .read = seq\_read, |
|  | .llseek = seq\_lseek, |
|  | .release = smaps\_rollup\_release, |
|  | }; |
|  |  |
|  | enum clear\_refs\_types { |
|  | CLEAR\_REFS\_ALL =1, |
|  | CLEAR\_REFS\_ANON, |
|  | CLEAR\_REFS\_MAPPED, |
|  | CLEAR\_REFS\_SOFT\_DIRTY, |
|  | CLEAR\_REFS\_MM\_HIWATER\_RSS, |
|  | CLEAR\_REFS\_LAST, |
|  | }; |
|  |  |
|  | struct clear\_refs\_private { |
|  | enum clear\_refs\_types type; |
|  | }; |
|  |  |
|  | #ifdef CONFIG\_MEM\_SOFT\_DIRTY |
|  |  |
|  | staticinlinebool pte\_is\_pinned(struct vm\_area\_struct \*vma,unsignedlong addr,pte\_t pte) |
|  | { |
|  | struct page \*page; |
|  |  |
|  | if(!pte\_write(pte)) |
|  | returnfalse; |
|  | if(!is\_cow\_mapping(vma->vm\_flags)) |
|  | returnfalse; |
|  | if(likely(!test\_bit(MMF\_HAS\_PINNED,&vma->vm\_mm->flags))) |
|  | returnfalse; |
|  | page = vm\_normal\_page(vma, addr, pte); |
|  | if(!page) |
|  | returnfalse; |
|  | return page\_maybe\_dma\_pinned(page); |
|  | } |
|  |  |
|  | staticinlinevoid clear\_soft\_dirty(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pte\_t\*pte) |
|  | { |
|  | /\* |
|  | \\* The soft-dirty tracker uses #PF-s to catch writes |
|  | \\* to pages, so write-protect the pte as well. See the |
|  | \\* Documentation/admin-guide/mm/soft-dirty.rst for full description |
|  | \\* of how soft-dirty works. |
|  | \*/ |
|  | pte\_t ptent = ptep\_get(pte); |
|  |  |
|  | if(pte\_present(ptent)){ |
|  | pte\_t old\_pte; |
|  |  |
|  | if(pte\_is\_pinned(vma, addr, ptent)) |
|  | return; |
|  | old\_pte = ptep\_modify\_prot\_start(vma, addr, pte); |
|  | ptent = pte\_wrprotect(old\_pte); |
|  | ptent = pte\_clear\_soft\_dirty(ptent); |
|  | ptep\_modify\_prot\_commit(vma, addr, pte, old\_pte, ptent); |
|  | }elseif(is\_swap\_pte(ptent)){ |
|  | ptent = pte\_swp\_clear\_soft\_dirty(ptent); |
|  | set\_pte\_at(vma->vm\_mm, addr, pte, ptent); |
|  | } |
|  | } |
|  | #else |
|  | staticinlinevoid clear\_soft\_dirty(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pte\_t\*pte) |
|  | { |
|  | } |
|  | #endif |
|  |  |
|  | #if defined(CONFIG\_MEM\_SOFT\_DIRTY) && defined(CONFIG\_TRANSPARENT\_HUGEPAGE) |
|  | staticinlinevoid clear\_soft\_dirty\_pmd(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pmd\_t\*pmdp) |
|  | { |
|  | pmd\_t old, pmd =\*pmdp; |
|  |  |
|  | if(pmd\_present(pmd)){ |
|  | /\\* See comment in change\_huge\_pmd() \*/ |
|  | old = pmdp\_invalidate(vma, addr, pmdp); |
|  | if(pmd\_dirty(old)) |
|  | pmd = pmd\_mkdirty(pmd); |
|  | if(pmd\_young(old)) |
|  | pmd = pmd\_mkyoung(pmd); |
|  |  |
|  | pmd = pmd\_wrprotect(pmd); |
|  | pmd = pmd\_clear\_soft\_dirty(pmd); |
|  |  |
|  | set\_pmd\_at(vma->vm\_mm, addr, pmdp, pmd); |
|  | }elseif(is\_migration\_entry(pmd\_to\_swp\_entry(pmd))){ |
|  | pmd = pmd\_swp\_clear\_soft\_dirty(pmd); |
|  | set\_pmd\_at(vma->vm\_mm, addr, pmdp, pmd); |
|  | } |
|  | } |
|  | #else |
|  | staticinlinevoid clear\_soft\_dirty\_pmd(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pmd\_t\*pmdp) |
|  | { |
|  | } |
|  | #endif |
|  |  |
|  | staticint clear\_refs\_pte\_range(pmd\_t\*pmd,unsignedlong addr, |
|  | unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | struct clear\_refs\_private \*cp = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | pte\_t\*pte, ptent; |
|  | spinlock\_t\*ptl; |
|  | struct page \*page; |
|  |  |
|  | ptl = pmd\_trans\_huge\_lock(pmd, vma); |
|  | if(ptl){ |
|  | if(cp->type == CLEAR\_REFS\_SOFT\_DIRTY){ |
|  | clear\_soft\_dirty\_pmd(vma, addr, pmd); |
|  | goto out; |
|  | } |
|  |  |
|  | if(!pmd\_present(\*pmd)) |
|  | goto out; |
|  |  |
|  | page = pmd\_page(\*pmd); |
|  |  |
|  | /\\* Clear accessed and referenced bits. \*/ |
|  | pmdp\_test\_and\_clear\_young(vma, addr, pmd); |
|  | test\_and\_clear\_page\_young(page); |
|  | ClearPageReferenced(page); |
|  | out: |
|  | spin\_unlock(ptl); |
|  | return0; |
|  | } |
|  |  |
|  | pte = pte\_offset\_map\_lock(vma->vm\_mm, pmd, addr,&ptl); |
|  | if(!pte){ |
|  | walk->action = ACTION\_AGAIN; |
|  | return0; |
|  | } |
|  | for(; addr != end; pte++, addr += PAGE\_SIZE){ |
|  | ptent = ptep\_get(pte); |
|  |  |
|  | if(cp->type == CLEAR\_REFS\_SOFT\_DIRTY){ |
|  | clear\_soft\_dirty(vma, addr, pte); |
|  | continue; |
|  | } |
|  |  |
|  | if(!pte\_present(ptent)) |
|  | continue; |
|  |  |
|  | page = vm\_normal\_page(vma, addr, ptent); |
|  | if(!page) |
|  | continue; |
|  |  |
|  | /\\* Clear accessed and referenced bits. \*/ |
|  | ptep\_test\_and\_clear\_young(vma, addr, pte); |
|  | test\_and\_clear\_page\_young(page); |
|  | ClearPageReferenced(page); |
|  | } |
|  | pte\_unmap\_unlock(pte -1, ptl); |
|  | cond\_resched(); |
|  | return0; |
|  | } |
|  |  |
|  | staticint clear\_refs\_test\_walk(unsignedlong start,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct clear\_refs\_private \*cp = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  |  |
|  | if(vma->vm\_flags & VM\_PFNMAP) |
|  | return1; |
|  |  |
|  | /\* |
|  | \\* Writing 1 to /proc/pid/clear\_refs affects all pages. |
|  | \\* Writing 2 to /proc/pid/clear\_refs only affects anonymous pages. |
|  | \\* Writing 3 to /proc/pid/clear\_refs only affects file mapped pages. |
|  | \\* Writing 4 to /proc/pid/clear\_refs affects all pages. |
|  | \*/ |
|  | if(cp->type == CLEAR\_REFS\_ANON && vma->vm\_file) |
|  | return1; |
|  | if(cp->type == CLEAR\_REFS\_MAPPED &&!vma->vm\_file) |
|  | return1; |
|  | return0; |
|  | } |
|  |  |
|  | staticconststruct mm\_walk\_ops clear\_refs\_walk\_ops ={ |
|  | .pmd\_entry = clear\_refs\_pte\_range, |
|  | .test\_walk = clear\_refs\_test\_walk, |
|  | .walk\_lock = PGWALK\_WRLOCK, |
|  | }; |
|  |  |
|  | staticssize\_t clear\_refs\_write(struct file \*file,constchar \_\_user \*buf, |
|  | size\_t count,loff\_t\*ppos) |
|  | { |
|  | struct task\_struct \*task; |
|  | char buffer\[PROC\_NUMBUF\]={}; |
|  | struct mm\_struct \*mm; |
|  | struct vm\_area\_struct \*vma; |
|  | enum clear\_refs\_types type; |
|  | int itype; |
|  | int rv; |
|  |  |
|  | if(count >sizeof(buffer)-1) |
|  | count =sizeof(buffer)-1; |
|  | if(copy\_from\_user(buffer, buf, count)) |
|  | return-EFAULT; |
|  | rv = kstrtoint(strstrip(buffer),10,&itype); |
|  | if(rv <0) |
|  | return rv; |
|  | type =(enum clear\_refs\_types)itype; |
|  | if(type < CLEAR\_REFS\_ALL \|\| type >= CLEAR\_REFS\_LAST) |
|  | return-EINVAL; |
|  |  |
|  | task = get\_proc\_task(file\_inode(file)); |
|  | if(!task) |
|  | return-ESRCH; |
|  | mm = get\_task\_mm(task); |
|  | if(mm){ |
|  | VMA\_ITERATOR(vmi, mm,0); |
|  | struct mmu\_notifier\_range range; |
|  | struct clear\_refs\_private cp ={ |
|  | .type = type, |
|  | }; |
|  |  |
|  | if(mmap\_write\_lock\_killable(mm)){ |
|  | count =-EINTR; |
|  | goto out\_mm; |
|  | } |
|  | if(type == CLEAR\_REFS\_MM\_HIWATER\_RSS){ |
|  | /\* |
|  | \\* Writing 5 to /proc/pid/clear\_refs resets the peak |
|  | \\* resident set size to this mm's current rss value. |
|  | \*/ |
|  | reset\_mm\_hiwater\_rss(mm); |
|  | goto out\_unlock; |
|  | } |
|  |  |
|  | if(type == CLEAR\_REFS\_SOFT\_DIRTY){ |
|  | for\_each\_vma(vmi, vma){ |
|  | if(!(vma->vm\_flags & VM\_SOFTDIRTY)) |
|  | continue; |
|  | vm\_flags\_clear(vma, VM\_SOFTDIRTY); |
|  | vma\_set\_page\_prot(vma); |
|  | } |
|  |  |
|  | inc\_tlb\_flush\_pending(mm); |
|  | mmu\_notifier\_range\_init(&range, MMU\_NOTIFY\_SOFT\_DIRTY, |
|  | 0, mm,0,-1UL); |
|  | mmu\_notifier\_invalidate\_range\_start(&range); |
|  | } |
|  | walk\_page\_range(mm,0,-1,&clear\_refs\_walk\_ops,&cp); |
|  | if(type == CLEAR\_REFS\_SOFT\_DIRTY){ |
|  | mmu\_notifier\_invalidate\_range\_end(&range); |
|  | flush\_tlb\_mm(mm); |
|  | dec\_tlb\_flush\_pending(mm); |
|  | } |
|  | out\_unlock: |
|  | mmap\_write\_unlock(mm); |
|  | out\_mm: |
|  | mmput(mm); |
|  | } |
|  | put\_task\_struct(task); |
|  |  |
|  | return count; |
|  | } |
|  |  |
|  | conststruct file\_operations proc\_clear\_refs\_operations ={ |
|  | .write = clear\_refs\_write, |
|  | .llseek = noop\_llseek, |
|  | }; |
|  |  |
|  | typedefstruct{ |
|  | u64 pme; |
|  | }pagemap\_entry\_t; |
|  |  |
|  | struct pagemapread { |
|  | int pos, len;/\\* units: PM\_ENTRY\_BYTES, not bytes \*/ |
|  | pagemap\_entry\_t\*buffer; |
|  | bool show\_pfn; |
|  | }; |
|  |  |
|  | #define PAGEMAP\_WALK\_SIZE (PMD\_SIZE) |
|  | #define PAGEMAP\_WALK\_MASK (PMD\_MASK) |
|  |  |
|  | #define PM\_ENTRY\_BYTES sizeof(pagemap\_entry\_t) |
|  | #define PM\_PFRAME\_BITS 55 |
|  | #define PM\_PFRAME\_MASK GENMASK\_ULL(PM\_PFRAME\_BITS -1,0) |
|  | #define PM\_SOFT\_DIRTY BIT\_ULL(55) |
|  | #define PM\_MMAP\_EXCLUSIVE BIT\_ULL(56) |
|  | #define PM\_UFFD\_WP BIT\_ULL(57) |
|  | #define PM\_FILE BIT\_ULL(61) |
|  | #define PM\_SWAP BIT\_ULL(62) |
|  | #define PM\_PRESENT BIT\_ULL(63) |
|  |  |
|  | #define PM\_END\_OF\_BUFFER 1 |
|  |  |
|  | staticinlinepagemap\_entry\_t make\_pme(u64 frame, u64 flags) |
|  | { |
|  | return(pagemap\_entry\_t){.pme =(frame & PM\_PFRAME\_MASK)\| flags }; |
|  | } |
|  |  |
|  | staticint add\_to\_pagemap(unsignedlong addr,pagemap\_entry\_t\*pme, |
|  | struct pagemapread \*pm) |
|  | { |
|  | pm->buffer\[pm->pos++\]=\*pme; |
|  | if(pm->pos >= pm->len) |
|  | return PM\_END\_OF\_BUFFER; |
|  | return0; |
|  | } |
|  |  |
|  | staticint pagemap\_pte\_hole(unsignedlong start,unsignedlong end, |
|  | \_\_always\_unused int depth,struct mm\_walk \*walk) |
|  | { |
|  | struct pagemapread \*pm = walk->private; |
|  | unsignedlong addr = start; |
|  | int err =0; |
|  |  |
|  | while(addr < end){ |
|  | struct vm\_area\_struct \*vma = find\_vma(walk->mm, addr); |
|  | pagemap\_entry\_t pme = make\_pme(0,0); |
|  | /\\* End of address space hole, which we mark as non-present. \*/ |
|  | unsignedlong hole\_end; |
|  |  |
|  | if(vma) |
|  | hole\_end = min(end, vma->vm\_start); |
|  | else |
|  | hole\_end = end; |
|  |  |
|  | for(; addr < hole\_end; addr += PAGE\_SIZE){ |
|  | err = add\_to\_pagemap(addr,&pme, pm); |
|  | if(err) |
|  | goto out; |
|  | } |
|  |  |
|  | if(!vma) |
|  | break; |
|  |  |
|  | /\\* Addresses in the VMA. \*/ |
|  | if(vma->vm\_flags & VM\_SOFTDIRTY) |
|  | pme = make\_pme(0, PM\_SOFT\_DIRTY); |
|  | for(; addr < min(end, vma->vm\_end); addr += PAGE\_SIZE){ |
|  | err = add\_to\_pagemap(addr,&pme, pm); |
|  | if(err) |
|  | goto out; |
|  | } |
|  | } |
|  | out: |
|  | return err; |
|  | } |
|  |  |
|  | staticpagemap\_entry\_t pte\_to\_pagemap\_entry(struct pagemapread \*pm, |
|  | struct vm\_area\_struct \*vma,unsignedlong addr,pte\_t pte) |
|  | { |
|  | u64 frame =0, flags =0; |
|  | struct page \*page = NULL; |
|  | bool migration =false; |
|  |  |
|  | if(pte\_present(pte)){ |
|  | if(pm->show\_pfn) |
|  | frame = pte\_pfn(pte); |
|  | flags \|= PM\_PRESENT; |
|  | page = vm\_normal\_page(vma, addr, pte); |
|  | if(pte\_soft\_dirty(pte)) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  | if(pte\_uffd\_wp(pte)) |
|  | flags \|= PM\_UFFD\_WP; |
|  | }elseif(is\_swap\_pte(pte)){ |
|  | swp\_entry\_t entry; |
|  | if(pte\_swp\_soft\_dirty(pte)) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  | if(pte\_swp\_uffd\_wp(pte)) |
|  | flags \|= PM\_UFFD\_WP; |
|  | entry = pte\_to\_swp\_entry(pte); |
|  | if(pm->show\_pfn){ |
|  | pgoff\_t offset; |
|  | /\* |
|  | \\* For PFN swap offsets, keeping the offset field |
|  | \\* to be PFN only to be compatible with old smaps. |
|  | \*/ |
|  | if(is\_pfn\_swap\_entry(entry)) |
|  | offset = swp\_offset\_pfn(entry); |
|  | else |
|  | offset = swp\_offset(entry); |
|  | frame = swp\_type(entry)\| |
|  | (offset << MAX\_SWAPFILES\_SHIFT); |
|  | } |
|  | flags \|= PM\_SWAP; |
|  | migration = is\_migration\_entry(entry); |
|  | if(is\_pfn\_swap\_entry(entry)) |
|  | page = pfn\_swap\_entry\_to\_page(entry); |
|  | if(pte\_marker\_entry\_uffd\_wp(entry)) |
|  | flags \|= PM\_UFFD\_WP; |
|  | } |
|  |  |
|  | if(page &&!PageAnon(page)) |
|  | flags \|= PM\_FILE; |
|  | if(page &&!migration && page\_mapcount(page)==1) |
|  | flags \|= PM\_MMAP\_EXCLUSIVE; |
|  | if(vma->vm\_flags & VM\_SOFTDIRTY) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  |  |
|  | return make\_pme(frame, flags); |
|  | } |
|  |  |
|  | staticint pagemap\_pmd\_range(pmd\_t\*pmdp,unsignedlong addr,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | struct pagemapread \*pm = walk->private; |
|  | spinlock\_t\*ptl; |
|  | pte\_t\*pte,\*orig\_pte; |
|  | int err =0; |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | bool migration =false; |
|  |  |
|  | ptl = pmd\_trans\_huge\_lock(pmdp, vma); |
|  | if(ptl){ |
|  | u64 flags =0, frame =0; |
|  | pmd\_t pmd =\*pmdp; |
|  | struct page \*page = NULL; |
|  |  |
|  | if(vma->vm\_flags & VM\_SOFTDIRTY) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  |  |
|  | if(pmd\_present(pmd)){ |
|  | page = pmd\_page(pmd); |
|  |  |
|  | flags \|= PM\_PRESENT; |
|  | if(pmd\_soft\_dirty(pmd)) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  | if(pmd\_uffd\_wp(pmd)) |
|  | flags \|= PM\_UFFD\_WP; |
|  | if(pm->show\_pfn) |
|  | frame = pmd\_pfn(pmd)+ |
|  | ((addr &~PMD\_MASK)>> PAGE\_SHIFT); |
|  | } |
|  | #ifdef CONFIG\_ARCH\_ENABLE\_THP\_MIGRATION |
|  | elseif(is\_swap\_pmd(pmd)){ |
|  | swp\_entry\_t entry = pmd\_to\_swp\_entry(pmd); |
|  | unsignedlong offset; |
|  |  |
|  | if(pm->show\_pfn){ |
|  | if(is\_pfn\_swap\_entry(entry)) |
|  | offset = swp\_offset\_pfn(entry); |
|  | else |
|  | offset = swp\_offset(entry); |
|  | offset = offset + |
|  | ((addr &~PMD\_MASK)>> PAGE\_SHIFT); |
|  | frame = swp\_type(entry)\| |
|  | (offset << MAX\_SWAPFILES\_SHIFT); |
|  | } |
|  | flags \|= PM\_SWAP; |
|  | if(pmd\_swp\_soft\_dirty(pmd)) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  | if(pmd\_swp\_uffd\_wp(pmd)) |
|  | flags \|= PM\_UFFD\_WP; |
|  | VM\_BUG\_ON(!is\_pmd\_migration\_entry(pmd)); |
|  | migration = is\_migration\_entry(entry); |
|  | page = pfn\_swap\_entry\_to\_page(entry); |
|  | } |
|  | #endif |
|  |  |
|  | if(page &&!migration && page\_mapcount(page)==1) |
|  | flags \|= PM\_MMAP\_EXCLUSIVE; |
|  |  |
|  | for(; addr != end; addr += PAGE\_SIZE){ |
|  | pagemap\_entry\_t pme = make\_pme(frame, flags); |
|  |  |
|  | err = add\_to\_pagemap(addr,&pme, pm); |
|  | if(err) |
|  | break; |
|  | if(pm->show\_pfn){ |
|  | if(flags & PM\_PRESENT) |
|  | frame++; |
|  | elseif(flags & PM\_SWAP) |
|  | frame +=(1<< MAX\_SWAPFILES\_SHIFT); |
|  | } |
|  | } |
|  | spin\_unlock(ptl); |
|  | return err; |
|  | } |
|  | #endif/\\* CONFIG\_TRANSPARENT\_HUGEPAGE \*/ |
|  |  |
|  | /\* |
|  | \\* We can assume that @vma always points to a valid one and @end never |
|  | \\* goes beyond vma->vm\_end. |
|  | \*/ |
|  | orig\_pte = pte = pte\_offset\_map\_lock(walk->mm, pmdp, addr,&ptl); |
|  | if(!pte){ |
|  | walk->action = ACTION\_AGAIN; |
|  | return err; |
|  | } |
|  | for(; addr < end; pte++, addr += PAGE\_SIZE){ |
|  | pagemap\_entry\_t pme; |
|  |  |
|  | pme = pte\_to\_pagemap\_entry(pm, vma, addr, ptep\_get(pte)); |
|  | err = add\_to\_pagemap(addr,&pme, pm); |
|  | if(err) |
|  | break; |
|  | } |
|  | pte\_unmap\_unlock(orig\_pte, ptl); |
|  |  |
|  | cond\_resched(); |
|  |  |
|  | return err; |
|  | } |
|  |  |
|  | #ifdef CONFIG\_HUGETLB\_PAGE |
|  | /\\* This function walks within one hugetlb entry in the single call \*/ |
|  | staticint pagemap\_hugetlb\_range(pte\_t\*ptep,unsignedlong hmask, |
|  | unsignedlong addr,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct pagemapread \*pm = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | u64 flags =0, frame =0; |
|  | int err =0; |
|  | pte\_t pte; |
|  |  |
|  | if(vma->vm\_flags & VM\_SOFTDIRTY) |
|  | flags \|= PM\_SOFT\_DIRTY; |
|  |  |
|  | pte = huge\_ptep\_get(ptep); |
|  | if(pte\_present(pte)){ |
|  | struct page \*page = pte\_page(pte); |
|  |  |
|  | if(!PageAnon(page)) |
|  | flags \|= PM\_FILE; |
|  |  |
|  | if(page\_mapcount(page)==1) |
|  | flags \|= PM\_MMAP\_EXCLUSIVE; |
|  |  |
|  | if(huge\_pte\_uffd\_wp(pte)) |
|  | flags \|= PM\_UFFD\_WP; |
|  |  |
|  | flags \|= PM\_PRESENT; |
|  | if(pm->show\_pfn) |
|  | frame = pte\_pfn(pte)+ |
|  | ((addr &~hmask)>> PAGE\_SHIFT); |
|  | }elseif(pte\_swp\_uffd\_wp\_any(pte)){ |
|  | flags \|= PM\_UFFD\_WP; |
|  | } |
|  |  |
|  | for(; addr != end; addr += PAGE\_SIZE){ |
|  | pagemap\_entry\_t pme = make\_pme(frame, flags); |
|  |  |
|  | err = add\_to\_pagemap(addr,&pme, pm); |
|  | if(err) |
|  | return err; |
|  | if(pm->show\_pfn &&(flags & PM\_PRESENT)) |
|  | frame++; |
|  | } |
|  |  |
|  | cond\_resched(); |
|  |  |
|  | return err; |
|  | } |
|  | #else |
|  | #define pagemap\_hugetlb\_range NULL |
|  | #endif/\\* HUGETLB\_PAGE \*/ |
|  |  |
|  | staticconststruct mm\_walk\_ops pagemap\_ops ={ |
|  | .pmd\_entry = pagemap\_pmd\_range, |
|  | .pte\_hole = pagemap\_pte\_hole, |
|  | .hugetlb\_entry = pagemap\_hugetlb\_range, |
|  | .walk\_lock = PGWALK\_RDLOCK, |
|  | }; |
|  |  |
|  | /\* |
|  | \\* /proc/pid/pagemap - an array mapping virtual pages to pfns |
|  | \* |
|  | \\* For each page in the address space, this file contains one 64-bit entry |
|  | \\* consisting of the following: |
|  | \* |
|  | \\* Bits 0-54 page frame number (PFN) if present |
|  | \\* Bits 0-4 swap type if swapped |
|  | \\* Bits 5-54 swap offset if swapped |
|  | \\* Bit 55 pte is soft-dirty (see Documentation/admin-guide/mm/soft-dirty.rst) |
|  | \\* Bit 56 page exclusively mapped |
|  | \\* Bit 57 pte is uffd-wp write-protected |
|  | \\* Bits 58-60 zero |
|  | \\* Bit 61 page is file-page or shared-anon |
|  | \\* Bit 62 page swapped |
|  | \\* Bit 63 page present |
|  | \* |
|  | \\* If the page is not present but in swap, then the PFN contains an |
|  | \\* encoding of the swap file number and the page's offset into the |
|  | \\* swap. Unmapped pages return a null PFN. This allows determining |
|  | \\* precisely which pages are mapped (or in swap) and comparing mapped |
|  | \\* pages between processes. |
|  | \* |
|  | \\* Efficient users of this interface will use /proc/pid/maps to |
|  | \\* determine which areas of memory are actually mapped and llseek to |
|  | \\* skip over unmapped regions. |
|  | \*/ |
|  | staticssize\_t pagemap\_read(struct file \*file,char \_\_user \*buf, |
|  | size\_t count,loff\_t\*ppos) |
|  | { |
|  | struct mm\_struct \*mm = file->private\_data; |
|  | struct pagemapread pm; |
|  | unsignedlong src; |
|  | unsignedlong svpfn; |
|  | unsignedlong start\_vaddr; |
|  | unsignedlong end\_vaddr; |
|  | int ret =0, copied =0; |
|  |  |
|  | if(!mm \|\|!mmget\_not\_zero(mm)) |
|  | goto out; |
|  |  |
|  | ret =-EINVAL; |
|  | /\\* file position must be aligned \*/ |
|  | if((\*ppos % PM\_ENTRY\_BYTES)\|\|(count % PM\_ENTRY\_BYTES)) |
|  | goto out\_mm; |
|  |  |
|  | ret =0; |
|  | if(!count) |
|  | goto out\_mm; |
|  |  |
|  | /\\* do not disclose physical addresses: attack vector \*/ |
|  | pm.show\_pfn = file\_ns\_capable(file,&init\_user\_ns, CAP\_SYS\_ADMIN); |
|  |  |
|  | pm.len =(PAGEMAP\_WALK\_SIZE >> PAGE\_SHIFT); |
|  | pm.buffer = kmalloc\_array(pm.len, PM\_ENTRY\_BYTES, GFP\_KERNEL); |
|  | ret =-ENOMEM; |
|  | if(!pm.buffer) |
|  | goto out\_mm; |
|  |  |
|  | src =\*ppos; |
|  | svpfn = src / PM\_ENTRY\_BYTES; |
|  | end\_vaddr = mm->task\_size; |
|  |  |
|  | /\\* watch out for wraparound \*/ |
|  | start\_vaddr = end\_vaddr; |
|  | if(svpfn <=(ULONG\_MAX >> PAGE\_SHIFT)){ |
|  | unsignedlong end; |
|  |  |
|  | ret = mmap\_read\_lock\_killable(mm); |
|  | if(ret) |
|  | goto out\_free; |
|  | start\_vaddr = untagged\_addr\_remote(mm, svpfn << PAGE\_SHIFT); |
|  | mmap\_read\_unlock(mm); |
|  |  |
|  | end = start\_vaddr +((count / PM\_ENTRY\_BYTES)<< PAGE\_SHIFT); |
|  | if(end >= start\_vaddr && end < mm->task\_size) |
|  | end\_vaddr = end; |
|  | } |
|  |  |
|  | /\\* Ensure the address is inside the task \*/ |
|  | if(start\_vaddr > mm->task\_size) |
|  | start\_vaddr = end\_vaddr; |
|  |  |
|  | ret =0; |
|  | while(count &&(start\_vaddr < end\_vaddr)){ |
|  | int len; |
|  | unsignedlong end; |
|  |  |
|  | pm.pos =0; |
|  | end =(start\_vaddr + PAGEMAP\_WALK\_SIZE)& PAGEMAP\_WALK\_MASK; |
|  | /\\* overflow ? \*/ |
|  | if(end < start\_vaddr \|\| end > end\_vaddr) |
|  | end = end\_vaddr; |
|  | ret = mmap\_read\_lock\_killable(mm); |
|  | if(ret) |
|  | goto out\_free; |
|  | ret = walk\_page\_range(mm, start\_vaddr, end,&pagemap\_ops,&pm); |
|  | mmap\_read\_unlock(mm); |
|  | start\_vaddr = end; |
|  |  |
|  | len = min(count, PM\_ENTRY\_BYTES \* pm.pos); |
|  | if(copy\_to\_user(buf, pm.buffer, len)){ |
|  | ret =-EFAULT; |
|  | goto out\_free; |
|  | } |
|  | copied += len; |
|  | buf += len; |
|  | count -= len; |
|  | } |
|  | \*ppos += copied; |
|  | if(!ret \|\| ret == PM\_END\_OF\_BUFFER) |
|  | ret = copied; |
|  |  |
|  | out\_free: |
|  | kfree(pm.buffer); |
|  | out\_mm: |
|  | mmput(mm); |
|  | out: |
|  | return ret; |
|  | } |
|  |  |
|  | staticint pagemap\_open(struct inode \*inode,struct file \*file) |
|  | { |
|  | struct mm\_struct \*mm; |
|  |  |
|  | mm = proc\_mem\_open(inode, PTRACE\_MODE\_READ); |
|  | if(IS\_ERR(mm)) |
|  | return PTR\_ERR(mm); |
|  | file->private\_data = mm; |
|  | return0; |
|  | } |
|  |  |
|  | staticint pagemap\_release(struct inode \*inode,struct file \*file) |
|  | { |
|  | struct mm\_struct \*mm = file->private\_data; |
|  |  |
|  | if(mm) |
|  | mmdrop(mm); |
|  | return0; |
|  | } |
|  |  |
|  | #define PM\_SCAN\_CATEGORIES (PAGE\_IS\_WPALLOWED \| PAGE\_IS\_WRITTEN \| \ |
|  | PAGE\_IS\_FILE \| PAGE\_IS\_PRESENT \| \ |
|  | PAGE\_IS\_SWAPPED \| PAGE\_IS\_PFNZERO \| \ |
|  | PAGE\_IS\_HUGE) |
|  | #define PM\_SCAN\_FLAGS (PM\_SCAN\_WP\_MATCHING \| PM\_SCAN\_CHECK\_WPASYNC) |
|  |  |
|  | struct pagemap\_scan\_private { |
|  | struct pm\_scan\_arg arg; |
|  | unsignedlong masks\_of\_interest, cur\_vma\_category; |
|  | struct page\_region \*vec\_buf; |
|  | unsignedlong vec\_buf\_len, vec\_buf\_index, found\_pages; |
|  | struct page\_region \_\_user \*vec\_out; |
|  | }; |
|  |  |
|  | staticunsignedlong pagemap\_page\_category(struct pagemap\_scan\_private \*p, |
|  | struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pte\_t pte) |
|  | { |
|  | unsignedlong categories =0; |
|  |  |
|  | if(pte\_present(pte)){ |
|  | struct page \*page; |
|  |  |
|  | categories \|= PAGE\_IS\_PRESENT; |
|  | if(!pte\_uffd\_wp(pte)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  |  |
|  | if(p->masks\_of\_interest & PAGE\_IS\_FILE){ |
|  | page = vm\_normal\_page(vma, addr, pte); |
|  | if(page &&!PageAnon(page)) |
|  | categories \|= PAGE\_IS\_FILE; |
|  | } |
|  |  |
|  | if(is\_zero\_pfn(pte\_pfn(pte))) |
|  | categories \|= PAGE\_IS\_PFNZERO; |
|  | }elseif(is\_swap\_pte(pte)){ |
|  | swp\_entry\_t swp; |
|  |  |
|  | categories \|= PAGE\_IS\_SWAPPED; |
|  | if(!pte\_swp\_uffd\_wp\_any(pte)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  |  |
|  | if(p->masks\_of\_interest & PAGE\_IS\_FILE){ |
|  | swp = pte\_to\_swp\_entry(pte); |
|  | if(is\_pfn\_swap\_entry(swp)&& |
|  | !PageAnon(pfn\_swap\_entry\_to\_page(swp))) |
|  | categories \|= PAGE\_IS\_FILE; |
|  | } |
|  | } |
|  |  |
|  | return categories; |
|  | } |
|  |  |
|  | staticvoid make\_uffd\_wp\_pte(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pte\_t\*pte) |
|  | { |
|  | pte\_t ptent = ptep\_get(pte); |
|  |  |
|  | if(pte\_present(ptent)){ |
|  | pte\_t old\_pte; |
|  |  |
|  | old\_pte = ptep\_modify\_prot\_start(vma, addr, pte); |
|  | ptent = pte\_mkuffd\_wp(ptent); |
|  | ptep\_modify\_prot\_commit(vma, addr, pte, old\_pte, ptent); |
|  | }elseif(is\_swap\_pte(ptent)){ |
|  | ptent = pte\_swp\_mkuffd\_wp(ptent); |
|  | set\_pte\_at(vma->vm\_mm, addr, pte, ptent); |
|  | }else{ |
|  | set\_pte\_at(vma->vm\_mm, addr, pte, |
|  | make\_pte\_marker(PTE\_MARKER\_UFFD\_WP)); |
|  | } |
|  | } |
|  |  |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | staticunsignedlong pagemap\_thp\_category(struct pagemap\_scan\_private \*p, |
|  | struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pmd\_t pmd) |
|  | { |
|  | unsignedlong categories = PAGE\_IS\_HUGE; |
|  |  |
|  | if(pmd\_present(pmd)){ |
|  | struct page \*page; |
|  |  |
|  | categories \|= PAGE\_IS\_PRESENT; |
|  | if(!pmd\_uffd\_wp(pmd)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  |  |
|  | if(p->masks\_of\_interest & PAGE\_IS\_FILE){ |
|  | page = vm\_normal\_page\_pmd(vma, addr, pmd); |
|  | if(page &&!PageAnon(page)) |
|  | categories \|= PAGE\_IS\_FILE; |
|  | } |
|  |  |
|  | if(is\_zero\_pfn(pmd\_pfn(pmd))) |
|  | categories \|= PAGE\_IS\_PFNZERO; |
|  | }elseif(is\_swap\_pmd(pmd)){ |
|  | swp\_entry\_t swp; |
|  |  |
|  | categories \|= PAGE\_IS\_SWAPPED; |
|  | if(!pmd\_swp\_uffd\_wp(pmd)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  |  |
|  | if(p->masks\_of\_interest & PAGE\_IS\_FILE){ |
|  | swp = pmd\_to\_swp\_entry(pmd); |
|  | if(is\_pfn\_swap\_entry(swp)&& |
|  | !PageAnon(pfn\_swap\_entry\_to\_page(swp))) |
|  | categories \|= PAGE\_IS\_FILE; |
|  | } |
|  | } |
|  |  |
|  | return categories; |
|  | } |
|  |  |
|  | staticvoid make\_uffd\_wp\_pmd(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pmd\_t\*pmdp) |
|  | { |
|  | pmd\_t old, pmd =\*pmdp; |
|  |  |
|  | if(pmd\_present(pmd)){ |
|  | old = pmdp\_invalidate\_ad(vma, addr, pmdp); |
|  | pmd = pmd\_mkuffd\_wp(old); |
|  | set\_pmd\_at(vma->vm\_mm, addr, pmdp, pmd); |
|  | }elseif(is\_migration\_entry(pmd\_to\_swp\_entry(pmd))){ |
|  | pmd = pmd\_swp\_mkuffd\_wp(pmd); |
|  | set\_pmd\_at(vma->vm\_mm, addr, pmdp, pmd); |
|  | } |
|  | } |
|  | #endif/\\* CONFIG\_TRANSPARENT\_HUGEPAGE \*/ |
|  |  |
|  | #ifdef CONFIG\_HUGETLB\_PAGE |
|  | staticunsignedlong pagemap\_hugetlb\_category(pte\_t pte) |
|  | { |
|  | unsignedlong categories = PAGE\_IS\_HUGE; |
|  |  |
|  | /\* |
|  | \\* According to pagemap\_hugetlb\_range(), file-backed HugeTLB |
|  | \\* page cannot be swapped. So PAGE\_IS\_FILE is not checked for |
|  | \\* swapped pages. |
|  | \*/ |
|  | if(pte\_present(pte)){ |
|  | categories \|= PAGE\_IS\_PRESENT; |
|  | if(!huge\_pte\_uffd\_wp(pte)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  | if(!PageAnon(pte\_page(pte))) |
|  | categories \|= PAGE\_IS\_FILE; |
|  | if(is\_zero\_pfn(pte\_pfn(pte))) |
|  | categories \|= PAGE\_IS\_PFNZERO; |
|  | }elseif(is\_swap\_pte(pte)){ |
|  | categories \|= PAGE\_IS\_SWAPPED; |
|  | if(!pte\_swp\_uffd\_wp\_any(pte)) |
|  | categories \|= PAGE\_IS\_WRITTEN; |
|  | } |
|  |  |
|  | return categories; |
|  | } |
|  |  |
|  | staticvoid make\_uffd\_wp\_huge\_pte(struct vm\_area\_struct \*vma, |
|  | unsignedlong addr,pte\_t\*ptep, |
|  | pte\_t ptent) |
|  | { |
|  | unsignedlong psize; |
|  |  |
|  | if(is\_hugetlb\_entry\_hwpoisoned(ptent)\|\| is\_pte\_marker(ptent)) |
|  | return; |
|  |  |
|  | psize = huge\_page\_size(hstate\_vma(vma)); |
|  |  |
|  | if(is\_hugetlb\_entry\_migration(ptent)) |
|  | set\_huge\_pte\_at(vma->vm\_mm, addr, ptep, |
|  | pte\_swp\_mkuffd\_wp(ptent), psize); |
|  | elseif(!huge\_pte\_none(ptent)) |
|  | huge\_ptep\_modify\_prot\_commit(vma, addr, ptep, ptent, |
|  | huge\_pte\_mkuffd\_wp(ptent)); |
|  | else |
|  | set\_huge\_pte\_at(vma->vm\_mm, addr, ptep, |
|  | make\_pte\_marker(PTE\_MARKER\_UFFD\_WP), psize); |
|  | } |
|  | #endif/\\* CONFIG\_HUGETLB\_PAGE \*/ |
|  |  |
|  | #if defined(CONFIG\_TRANSPARENT\_HUGEPAGE) \|\| defined(CONFIG\_HUGETLB\_PAGE) |
|  | staticvoid pagemap\_scan\_backout\_range(struct pagemap\_scan\_private \*p, |
|  | unsignedlong addr,unsignedlong end) |
|  | { |
|  | struct page\_region \*cur\_buf =&p->vec\_buf\[p->vec\_buf\_index\]; |
|  |  |
|  | if(cur\_buf->start != addr) |
|  | cur\_buf->end = addr; |
|  | else |
|  | cur\_buf->start = cur\_buf->end =0; |
|  |  |
|  | p->found\_pages -=(end - addr)/ PAGE\_SIZE; |
|  | } |
|  | #endif |
|  |  |
|  | staticbool pagemap\_scan\_is\_interesting\_page(unsignedlong categories, |
|  | conststruct pagemap\_scan\_private \*p) |
|  | { |
|  | categories ^= p->arg.category\_inverted; |
|  | if((categories & p->arg.category\_mask)!= p->arg.category\_mask) |
|  | returnfalse; |
|  | if(p->arg.category\_anyof\_mask &&!(categories & p->arg.category\_anyof\_mask)) |
|  | returnfalse; |
|  |  |
|  | returntrue; |
|  | } |
|  |  |
|  | staticbool pagemap\_scan\_is\_interesting\_vma(unsignedlong categories, |
|  | conststruct pagemap\_scan\_private \*p) |
|  | { |
|  | unsignedlong required = p->arg.category\_mask & PAGE\_IS\_WPALLOWED; |
|  |  |
|  | categories ^= p->arg.category\_inverted; |
|  | if((categories & required)!= required) |
|  | returnfalse; |
|  |  |
|  | returntrue; |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_test\_walk(unsignedlong start,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct pagemap\_scan\_private \*p = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | unsignedlong vma\_category =0; |
|  |  |
|  | if(userfaultfd\_wp\_async(vma)&& userfaultfd\_wp\_use\_markers(vma)) |
|  | vma\_category \|= PAGE\_IS\_WPALLOWED; |
|  | elseif(p->arg.flags & PM\_SCAN\_CHECK\_WPASYNC) |
|  | return-EPERM; |
|  |  |
|  | if(vma->vm\_flags & VM\_PFNMAP) |
|  | return1; |
|  |  |
|  | if(!pagemap\_scan\_is\_interesting\_vma(vma\_category, p)) |
|  | return1; |
|  |  |
|  | p->cur\_vma\_category = vma\_category; |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticbool pagemap\_scan\_push\_range(unsignedlong categories, |
|  | struct pagemap\_scan\_private \*p, |
|  | unsignedlong addr,unsignedlong end) |
|  | { |
|  | struct page\_region \*cur\_buf =&p->vec\_buf\[p->vec\_buf\_index\]; |
|  |  |
|  | /\* |
|  | \\* When there is no output buffer provided at all, the sentinel values |
|  | \\* won't match here. There is no other way for \`cur\_buf->end\` to be |
|  | \\* non-zero other than it being non-empty. |
|  | \*/ |
|  | if(addr == cur\_buf->end && categories == cur\_buf->categories){ |
|  | cur\_buf->end = end; |
|  | returntrue; |
|  | } |
|  |  |
|  | if(cur\_buf->end){ |
|  | if(p->vec\_buf\_index >= p->vec\_buf\_len -1) |
|  | returnfalse; |
|  |  |
|  | cur\_buf =&p->vec\_buf\[++p->vec\_buf\_index\]; |
|  | } |
|  |  |
|  | cur\_buf->start = addr; |
|  | cur\_buf->end = end; |
|  | cur\_buf->categories = categories; |
|  |  |
|  | returntrue; |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_output(unsignedlong categories, |
|  | struct pagemap\_scan\_private \*p, |
|  | unsignedlong addr,unsignedlong\*end) |
|  | { |
|  | unsignedlong n\_pages, total\_pages; |
|  | int ret =0; |
|  |  |
|  | if(!p->vec\_buf) |
|  | return0; |
|  |  |
|  | categories &= p->arg.return\_mask; |
|  |  |
|  | n\_pages =(\*end - addr)/ PAGE\_SIZE; |
|  | if(check\_add\_overflow(p->found\_pages, n\_pages,&total\_pages)\|\| |
|  | total\_pages > p->arg.max\_pages){ |
|  | size\_t n\_too\_much = total\_pages - p->arg.max\_pages; |
|  | \*end -= n\_too\_much \* PAGE\_SIZE; |
|  | n\_pages -= n\_too\_much; |
|  | ret =-ENOSPC; |
|  | } |
|  |  |
|  | if(!pagemap\_scan\_push\_range(categories, p, addr,\*end)){ |
|  | \*end = addr; |
|  | n\_pages =0; |
|  | ret =-ENOSPC; |
|  | } |
|  |  |
|  | p->found\_pages += n\_pages; |
|  | if(ret) |
|  | p->arg.walk\_end =\*end; |
|  |  |
|  | return ret; |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_thp\_entry(pmd\_t\*pmd,unsignedlong start, |
|  | unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | struct pagemap\_scan\_private \*p = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | unsignedlong categories; |
|  | spinlock\_t\*ptl; |
|  | int ret =0; |
|  |  |
|  | ptl = pmd\_trans\_huge\_lock(pmd, vma); |
|  | if(!ptl) |
|  | return-ENOENT; |
|  |  |
|  | categories = p->cur\_vma\_category \| |
|  | pagemap\_thp\_category(p, vma, start,\*pmd); |
|  |  |
|  | if(!pagemap\_scan\_is\_interesting\_page(categories, p)) |
|  | goto out\_unlock; |
|  |  |
|  | ret = pagemap\_scan\_output(categories, p, start,&end); |
|  | if(start == end) |
|  | goto out\_unlock; |
|  |  |
|  | if(~p->arg.flags & PM\_SCAN\_WP\_MATCHING) |
|  | goto out\_unlock; |
|  | if(~categories & PAGE\_IS\_WRITTEN) |
|  | goto out\_unlock; |
|  |  |
|  | /\* |
|  | \\* Break huge page into small pages if the WP operation |
|  | \\* needs to be performed on a portion of the huge page. |
|  | \*/ |
|  | if(end != start + HPAGE\_SIZE){ |
|  | spin\_unlock(ptl); |
|  | split\_huge\_pmd(vma, pmd, start); |
|  | pagemap\_scan\_backout\_range(p, start, end); |
|  | /\\* Report as if there was no THP \*/ |
|  | return-ENOENT; |
|  | } |
|  |  |
|  | make\_uffd\_wp\_pmd(vma, start, pmd); |
|  | flush\_tlb\_range(vma, start, end); |
|  | out\_unlock: |
|  | spin\_unlock(ptl); |
|  | return ret; |
|  | #else/\\* !CONFIG\_TRANSPARENT\_HUGEPAGE \*/ |
|  | return-ENOENT; |
|  | #endif |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_pmd\_entry(pmd\_t\*pmd,unsignedlong start, |
|  | unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | struct pagemap\_scan\_private \*p = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | unsignedlong addr, flush\_end =0; |
|  | pte\_t\*pte,\*start\_pte; |
|  | spinlock\_t\*ptl; |
|  | int ret; |
|  |  |
|  | arch\_enter\_lazy\_mmu\_mode(); |
|  |  |
|  | ret = pagemap\_scan\_thp\_entry(pmd, start, end, walk); |
|  | if(ret !=-ENOENT){ |
|  | arch\_leave\_lazy\_mmu\_mode(); |
|  | return ret; |
|  | } |
|  |  |
|  | ret =0; |
|  | start\_pte = pte = pte\_offset\_map\_lock(vma->vm\_mm, pmd, start,&ptl); |
|  | if(!pte){ |
|  | arch\_leave\_lazy\_mmu\_mode(); |
|  | walk->action = ACTION\_AGAIN; |
|  | return0; |
|  | } |
|  |  |
|  | if(!p->vec\_out){ |
|  | /\\* Fast path for performing exclusive WP \*/ |
|  | for(addr = start; addr != end; pte++, addr += PAGE\_SIZE){ |
|  | if(pte\_uffd\_wp(ptep\_get(pte))) |
|  | continue; |
|  | make\_uffd\_wp\_pte(vma, addr, pte); |
|  | if(!flush\_end) |
|  | start = addr; |
|  | flush\_end = addr + PAGE\_SIZE; |
|  | } |
|  | goto flush\_and\_return; |
|  | } |
|  |  |
|  | if(!p->arg.category\_anyof\_mask &&!p->arg.category\_inverted && |
|  | p->arg.category\_mask == PAGE\_IS\_WRITTEN && |
|  | p->arg.return\_mask == PAGE\_IS\_WRITTEN){ |
|  | for(addr = start; addr < end; pte++, addr += PAGE\_SIZE){ |
|  | unsignedlong next = addr + PAGE\_SIZE; |
|  |  |
|  | if(pte\_uffd\_wp(ptep\_get(pte))) |
|  | continue; |
|  | ret = pagemap\_scan\_output(p->cur\_vma\_category \| PAGE\_IS\_WRITTEN, |
|  | p, addr,&next); |
|  | if(next == addr) |
|  | break; |
|  | if(~p->arg.flags & PM\_SCAN\_WP\_MATCHING) |
|  | continue; |
|  | make\_uffd\_wp\_pte(vma, addr, pte); |
|  | if(!flush\_end) |
|  | start = addr; |
|  | flush\_end = next; |
|  | } |
|  | goto flush\_and\_return; |
|  | } |
|  |  |
|  | for(addr = start; addr != end; pte++, addr += PAGE\_SIZE){ |
|  | unsignedlong categories = p->cur\_vma\_category \| |
|  | pagemap\_page\_category(p, vma, addr, ptep\_get(pte)); |
|  | unsignedlong next = addr + PAGE\_SIZE; |
|  |  |
|  | if(!pagemap\_scan\_is\_interesting\_page(categories, p)) |
|  | continue; |
|  |  |
|  | ret = pagemap\_scan\_output(categories, p, addr,&next); |
|  | if(next == addr) |
|  | break; |
|  |  |
|  | if(~p->arg.flags & PM\_SCAN\_WP\_MATCHING) |
|  | continue; |
|  | if(~categories & PAGE\_IS\_WRITTEN) |
|  | continue; |
|  |  |
|  | make\_uffd\_wp\_pte(vma, addr, pte); |
|  | if(!flush\_end) |
|  | start = addr; |
|  | flush\_end = next; |
|  | } |
|  |  |
|  | flush\_and\_return: |
|  | if(flush\_end) |
|  | flush\_tlb\_range(vma, start, addr); |
|  |  |
|  | pte\_unmap\_unlock(start\_pte, ptl); |
|  | arch\_leave\_lazy\_mmu\_mode(); |
|  |  |
|  | cond\_resched(); |
|  | return ret; |
|  | } |
|  |  |
|  | #ifdef CONFIG\_HUGETLB\_PAGE |
|  | staticint pagemap\_scan\_hugetlb\_entry(pte\_t\*ptep,unsignedlong hmask, |
|  | unsignedlong start,unsignedlong end, |
|  | struct mm\_walk \*walk) |
|  | { |
|  | struct pagemap\_scan\_private \*p = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | unsignedlong categories; |
|  | spinlock\_t\*ptl; |
|  | int ret =0; |
|  | pte\_t pte; |
|  |  |
|  | if(~p->arg.flags & PM\_SCAN\_WP\_MATCHING){ |
|  | /\\* Go the short route when not write-protecting pages. \*/ |
|  |  |
|  | pte = huge\_ptep\_get(ptep); |
|  | categories = p->cur\_vma\_category \| pagemap\_hugetlb\_category(pte); |
|  |  |
|  | if(!pagemap\_scan\_is\_interesting\_page(categories, p)) |
|  | return0; |
|  |  |
|  | return pagemap\_scan\_output(categories, p, start,&end); |
|  | } |
|  |  |
|  | i\_mmap\_lock\_write(vma->vm\_file->f\_mapping); |
|  | ptl = huge\_pte\_lock(hstate\_vma(vma), vma->vm\_mm, ptep); |
|  |  |
|  | pte = huge\_ptep\_get(ptep); |
|  | categories = p->cur\_vma\_category \| pagemap\_hugetlb\_category(pte); |
|  |  |
|  | if(!pagemap\_scan\_is\_interesting\_page(categories, p)) |
|  | goto out\_unlock; |
|  |  |
|  | ret = pagemap\_scan\_output(categories, p, start,&end); |
|  | if(start == end) |
|  | goto out\_unlock; |
|  |  |
|  | if(~categories & PAGE\_IS\_WRITTEN) |
|  | goto out\_unlock; |
|  |  |
|  | if(end != start + HPAGE\_SIZE){ |
|  | /\\* Partial HugeTLB page WP isn't possible. \*/ |
|  | pagemap\_scan\_backout\_range(p, start, end); |
|  | p->arg.walk\_end = start; |
|  | ret =0; |
|  | goto out\_unlock; |
|  | } |
|  |  |
|  | make\_uffd\_wp\_huge\_pte(vma, start, ptep, pte); |
|  | flush\_hugetlb\_tlb\_range(vma, start, end); |
|  |  |
|  | out\_unlock: |
|  | spin\_unlock(ptl); |
|  | i\_mmap\_unlock\_write(vma->vm\_file->f\_mapping); |
|  |  |
|  | return ret; |
|  | } |
|  | #else |
|  | #define pagemap\_scan\_hugetlb\_entry NULL |
|  | #endif |
|  |  |
|  | staticint pagemap\_scan\_pte\_hole(unsignedlong addr,unsignedlong end, |
|  | int depth,struct mm\_walk \*walk) |
|  | { |
|  | struct pagemap\_scan\_private \*p = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | int ret, err; |
|  |  |
|  | if(!vma \|\|!pagemap\_scan\_is\_interesting\_page(p->cur\_vma\_category, p)) |
|  | return0; |
|  |  |
|  | ret = pagemap\_scan\_output(p->cur\_vma\_category, p, addr,&end); |
|  | if(addr == end) |
|  | return ret; |
|  |  |
|  | if(~p->arg.flags & PM\_SCAN\_WP\_MATCHING) |
|  | return ret; |
|  |  |
|  | err = uffd\_wp\_range(vma, addr, end - addr,true); |
|  | if(err <0) |
|  | ret = err; |
|  |  |
|  | return ret; |
|  | } |
|  |  |
|  | staticconststruct mm\_walk\_ops pagemap\_scan\_ops ={ |
|  | .test\_walk = pagemap\_scan\_test\_walk, |
|  | .pmd\_entry = pagemap\_scan\_pmd\_entry, |
|  | .pte\_hole = pagemap\_scan\_pte\_hole, |
|  | .hugetlb\_entry = pagemap\_scan\_hugetlb\_entry, |
|  | }; |
|  |  |
|  | staticint pagemap\_scan\_get\_args(struct pm\_scan\_arg \*arg, |
|  | unsignedlong uarg) |
|  | { |
|  | if(copy\_from\_user(arg,(void \_\_user \*)uarg,sizeof(\*arg))) |
|  | return-EFAULT; |
|  |  |
|  | if(arg->size !=sizeof(struct pm\_scan\_arg)) |
|  | return-EINVAL; |
|  |  |
|  | /\\* Validate requested features \*/ |
|  | if(arg->flags &~PM\_SCAN\_FLAGS) |
|  | return-EINVAL; |
|  | if((arg->category\_inverted \| arg->category\_mask \| |
|  | arg->category\_anyof\_mask \| arg->return\_mask)&~PM\_SCAN\_CATEGORIES) |
|  | return-EINVAL; |
|  |  |
|  | arg->start = untagged\_addr((unsignedlong)arg->start); |
|  | arg->end = untagged\_addr((unsignedlong)arg->end); |
|  | arg->vec = untagged\_addr((unsignedlong)arg->vec); |
|  |  |
|  | /\\* Validate memory pointers \*/ |
|  | if(!IS\_ALIGNED(arg->start, PAGE\_SIZE)) |
|  | return-EINVAL; |
|  | if(!access\_ok((void \_\_user \*)(long)arg->start, arg->end - arg->start)) |
|  | return-EFAULT; |
|  | if(!arg->vec && arg->vec\_len) |
|  | return-EINVAL; |
|  | if(arg->vec &&!access\_ok((void \_\_user \*)(long)arg->vec, |
|  | arg->vec\_len \*sizeof(struct page\_region))) |
|  | return-EFAULT; |
|  |  |
|  | /\\* Fixup default values \*/ |
|  | arg->end = ALIGN(arg->end, PAGE\_SIZE); |
|  | arg->walk\_end =0; |
|  | if(!arg->max\_pages) |
|  | arg->max\_pages = ULONG\_MAX; |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_writeback\_args(struct pm\_scan\_arg \*arg, |
|  | unsignedlong uargl) |
|  | { |
|  | struct pm\_scan\_arg \_\_user \*uarg =(void \_\_user \*)uargl; |
|  |  |
|  | if(copy\_to\_user(&uarg->walk\_end,&arg->walk\_end,sizeof(arg->walk\_end))) |
|  | return-EFAULT; |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticint pagemap\_scan\_init\_bounce\_buffer(struct pagemap\_scan\_private \*p) |
|  | { |
|  | if(!p->arg.vec\_len) |
|  | return0; |
|  |  |
|  | p->vec\_buf\_len =min\_t(size\_t, PAGEMAP\_WALK\_SIZE >> PAGE\_SHIFT, |
|  | p->arg.vec\_len); |
|  | p->vec\_buf = kmalloc\_array(p->vec\_buf\_len,sizeof(\*p->vec\_buf), |
|  | GFP\_KERNEL); |
|  | if(!p->vec\_buf) |
|  | return-ENOMEM; |
|  |  |
|  | p->vec\_buf->start = p->vec\_buf->end =0; |
|  | p->vec\_out =(struct page\_region \_\_user \*)(long)p->arg.vec; |
|  |  |
|  | return0; |
|  | } |
|  |  |
|  | staticlong pagemap\_scan\_flush\_buffer(struct pagemap\_scan\_private \*p) |
|  | { |
|  | conststruct page\_region \*buf = p->vec\_buf; |
|  | long n = p->vec\_buf\_index; |
|  |  |
|  | if(!p->vec\_buf) |
|  | return0; |
|  |  |
|  | if(buf\[n\].end != buf\[n\].start) |
|  | n++; |
|  |  |
|  | if(!n) |
|  | return0; |
|  |  |
|  | if(copy\_to\_user(p->vec\_out, buf, n \*sizeof(\*buf))) |
|  | return-EFAULT; |
|  |  |
|  | p->arg.vec\_len -= n; |
|  | p->vec\_out += n; |
|  |  |
|  | p->vec\_buf\_index =0; |
|  | p->vec\_buf\_len =min\_t(size\_t, p->vec\_buf\_len, p->arg.vec\_len); |
|  | p->vec\_buf->start = p->vec\_buf->end =0; |
|  |  |
|  | return n; |
|  | } |
|  |  |
|  | staticlong do\_pagemap\_scan(struct mm\_struct \*mm,unsignedlong uarg) |
|  | { |
|  | struct mmu\_notifier\_range range; |
|  | struct pagemap\_scan\_private p ={0}; |
|  | unsignedlong walk\_start; |
|  | size\_t n\_ranges\_out =0; |
|  | int ret; |
|  |  |
|  | ret = pagemap\_scan\_get\_args(&p.arg, uarg); |
|  | if(ret) |
|  | return ret; |
|  |  |
|  | p.masks\_of\_interest = p.arg.category\_mask \| p.arg.category\_anyof\_mask \| |
|  | p.arg.return\_mask; |
|  | ret = pagemap\_scan\_init\_bounce\_buffer(&p); |
|  | if(ret) |
|  | return ret; |
|  |  |
|  | /\\* Protection change for the range is going to happen. \*/ |
|  | if(p.arg.flags & PM\_SCAN\_WP\_MATCHING){ |
|  | mmu\_notifier\_range\_init(&range, MMU\_NOTIFY\_PROTECTION\_VMA,0, |
|  | mm, p.arg.start, p.arg.end); |
|  | mmu\_notifier\_invalidate\_range\_start(&range); |
|  | } |
|  |  |
|  | for(walk\_start = p.arg.start; walk\_start < p.arg.end; |
|  | walk\_start = p.arg.walk\_end){ |
|  | long n\_out; |
|  |  |
|  | if(fatal\_signal\_pending(current)){ |
|  | ret =-EINTR; |
|  | break; |
|  | } |
|  |  |
|  | ret = mmap\_read\_lock\_killable(mm); |
|  | if(ret) |
|  | break; |
|  | ret = walk\_page\_range(mm, walk\_start, p.arg.end, |
|  | &pagemap\_scan\_ops,&p); |
|  | mmap\_read\_unlock(mm); |
|  |  |
|  | n\_out = pagemap\_scan\_flush\_buffer(&p); |
|  | if(n\_out <0) |
|  | ret = n\_out; |
|  | else |
|  | n\_ranges\_out += n\_out; |
|  |  |
|  | if(ret !=-ENOSPC) |
|  | break; |
|  |  |
|  | if(p.arg.vec\_len ==0\|\| p.found\_pages == p.arg.max\_pages) |
|  | break; |
|  | } |
|  |  |
|  | /\\* ENOSPC signifies early stop (buffer full) from the walk. \*/ |
|  | if(!ret \|\| ret ==-ENOSPC) |
|  | ret = n\_ranges\_out; |
|  |  |
|  | /\\* The walk\_end isn't set when ret is zero \*/ |
|  | if(!p.arg.walk\_end) |
|  | p.arg.walk\_end = p.arg.end; |
|  | if(pagemap\_scan\_writeback\_args(&p.arg, uarg)) |
|  | ret =-EFAULT; |
|  |  |
|  | if(p.arg.flags & PM\_SCAN\_WP\_MATCHING) |
|  | mmu\_notifier\_invalidate\_range\_end(&range); |
|  |  |
|  | kfree(p.vec\_buf); |
|  | return ret; |
|  | } |
|  |  |
|  | staticlong do\_pagemap\_cmd(struct file \*file,unsignedint cmd, |
|  | unsignedlong arg) |
|  | { |
|  | struct mm\_struct \*mm = file->private\_data; |
|  |  |
|  | switch(cmd){ |
|  | case PAGEMAP\_SCAN: |
|  | return do\_pagemap\_scan(mm, arg); |
|  |  |
|  | default: |
|  | return-EINVAL; |
|  | } |
|  | } |
|  |  |
|  | conststruct file\_operations proc\_pagemap\_operations ={ |
|  | .llseek = mem\_lseek,/\\* borrow this \*/ |
|  | .read = pagemap\_read, |
|  | .open = pagemap\_open, |
|  | .release = pagemap\_release, |
|  | .unlocked\_ioctl = do\_pagemap\_cmd, |
|  | .compat\_ioctl = do\_pagemap\_cmd, |
|  | }; |
|  | #endif/\\* CONFIG\_PROC\_PAGE\_MONITOR \*/ |
|  |  |
|  | #ifdef CONFIG\_NUMA |
|  |  |
|  | struct numa\_maps { |
|  | unsignedlong pages; |
|  | unsignedlong anon; |
|  | unsignedlong active; |
|  | unsignedlong writeback; |
|  | unsignedlong mapcount\_max; |
|  | unsignedlong dirty; |
|  | unsignedlong swapcache; |
|  | unsignedlong node\[MAX\_NUMNODES\]; |
|  | }; |
|  |  |
|  | struct numa\_maps\_private { |
|  | struct proc\_maps\_private proc\_maps; |
|  | struct numa\_maps md; |
|  | }; |
|  |  |
|  | staticvoid gather\_stats(struct page \*page,struct numa\_maps \*md,int pte\_dirty, |
|  | unsignedlong nr\_pages) |
|  | { |
|  | int count = page\_mapcount(page); |
|  |  |
|  | md->pages += nr\_pages; |
|  | if(pte\_dirty \|\|PageDirty(page)) |
|  | md->dirty += nr\_pages; |
|  |  |
|  | if(PageSwapCache(page)) |
|  | md->swapcache += nr\_pages; |
|  |  |
|  | if(PageActive(page)\|\|PageUnevictable(page)) |
|  | md->active += nr\_pages; |
|  |  |
|  | if(PageWriteback(page)) |
|  | md->writeback += nr\_pages; |
|  |  |
|  | if(PageAnon(page)) |
|  | md->anon += nr\_pages; |
|  |  |
|  | if(count > md->mapcount\_max) |
|  | md->mapcount\_max = count; |
|  |  |
|  | md->node\[page\_to\_nid(page)\]+= nr\_pages; |
|  | } |
|  |  |
|  | staticstruct page \*can\_gather\_numa\_stats(pte\_t pte,struct vm\_area\_struct \*vma, |
|  | unsignedlong addr) |
|  | { |
|  | struct page \*page; |
|  | int nid; |
|  |  |
|  | if(!pte\_present(pte)) |
|  | return NULL; |
|  |  |
|  | page = vm\_normal\_page(vma, addr, pte); |
|  | if(!page \|\| is\_zone\_device\_page(page)) |
|  | return NULL; |
|  |  |
|  | if(PageReserved(page)) |
|  | return NULL; |
|  |  |
|  | nid = page\_to\_nid(page); |
|  | if(!node\_isset(nid, node\_states\[N\_MEMORY\])) |
|  | return NULL; |
|  |  |
|  | return page; |
|  | } |
|  |  |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | staticstruct page \*can\_gather\_numa\_stats\_pmd(pmd\_t pmd, |
|  | struct vm\_area\_struct \*vma, |
|  | unsignedlong addr) |
|  | { |
|  | struct page \*page; |
|  | int nid; |
|  |  |
|  | if(!pmd\_present(pmd)) |
|  | return NULL; |
|  |  |
|  | page = vm\_normal\_page\_pmd(vma, addr, pmd); |
|  | if(!page) |
|  | return NULL; |
|  |  |
|  | if(PageReserved(page)) |
|  | return NULL; |
|  |  |
|  | nid = page\_to\_nid(page); |
|  | if(!node\_isset(nid, node\_states\[N\_MEMORY\])) |
|  | return NULL; |
|  |  |
|  | return page; |
|  | } |
|  | #endif |
|  |  |
|  | staticint gather\_pte\_stats(pmd\_t\*pmd,unsignedlong addr, |
|  | unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | struct numa\_maps \*md = walk->private; |
|  | struct vm\_area\_struct \*vma = walk->vma; |
|  | spinlock\_t\*ptl; |
|  | pte\_t\*orig\_pte; |
|  | pte\_t\*pte; |
|  |  |
|  | #ifdef CONFIG\_TRANSPARENT\_HUGEPAGE |
|  | ptl = pmd\_trans\_huge\_lock(pmd, vma); |
|  | if(ptl){ |
|  | struct page \*page; |
|  |  |
|  | page = can\_gather\_numa\_stats\_pmd(\*pmd, vma, addr); |
|  | if(page) |
|  | gather\_stats(page, md, pmd\_dirty(\*pmd), |
|  | HPAGE\_PMD\_SIZE/PAGE\_SIZE); |
|  | spin\_unlock(ptl); |
|  | return0; |
|  | } |
|  | #endif |
|  | orig\_pte = pte = pte\_offset\_map\_lock(walk->mm, pmd, addr,&ptl); |
|  | if(!pte){ |
|  | walk->action = ACTION\_AGAIN; |
|  | return0; |
|  | } |
|  | do{ |
|  | pte\_t ptent = ptep\_get(pte); |
|  | struct page \*page = can\_gather\_numa\_stats(ptent, vma, addr); |
|  | if(!page) |
|  | continue; |
|  | gather\_stats(page, md, pte\_dirty(ptent),1); |
|  |  |
|  | }while(pte++, addr += PAGE\_SIZE, addr != end); |
|  | pte\_unmap\_unlock(orig\_pte, ptl); |
|  | cond\_resched(); |
|  | return0; |
|  | } |
|  | #ifdef CONFIG\_HUGETLB\_PAGE |
|  | staticint gather\_hugetlb\_stats(pte\_t\*pte,unsignedlong hmask, |
|  | unsignedlong addr,unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | pte\_t huge\_pte = huge\_ptep\_get(pte); |
|  | struct numa\_maps \*md; |
|  | struct page \*page; |
|  |  |
|  | if(!pte\_present(huge\_pte)) |
|  | return0; |
|  |  |
|  | page = pte\_page(huge\_pte); |
|  |  |
|  | md = walk->private; |
|  | gather\_stats(page, md, pte\_dirty(huge\_pte),1); |
|  | return0; |
|  | } |
|  |  |
|  | #else |
|  | staticint gather\_hugetlb\_stats(pte\_t\*pte,unsignedlong hmask, |
|  | unsignedlong addr,unsignedlong end,struct mm\_walk \*walk) |
|  | { |
|  | return0; |
|  | } |
|  | #endif |
|  |  |
|  | staticconststruct mm\_walk\_ops show\_numa\_ops ={ |
|  | .hugetlb\_entry = gather\_hugetlb\_stats, |
|  | .pmd\_entry = gather\_pte\_stats, |
|  | .walk\_lock = PGWALK\_RDLOCK, |
|  | }; |
|  |  |
|  | /\* |
|  | \\* Display pages allocated per node and memory policy via /proc. |
|  | \*/ |
|  | staticint show\_numa\_map(struct seq\_file \*m,void\*v) |
|  | { |
|  | struct numa\_maps\_private \*numa\_priv = m->private; |
|  | struct proc\_maps\_private \*proc\_priv =&numa\_priv->proc\_maps; |
|  | struct vm\_area\_struct \*vma = v; |
|  | struct numa\_maps \*md =&numa\_priv->md; |
|  | struct file \*file = vma->vm\_file; |
|  | struct mm\_struct \*mm = vma->vm\_mm; |
|  | char buffer\[64\]; |
|  | struct mempolicy \*pol; |
|  | pgoff\_t ilx; |
|  | int nid; |
|  |  |
|  | if(!mm) |
|  | return0; |
|  |  |
|  | /\\* Ensure we start with an empty set of numa\_maps statistics. \*/ |
|  | memset(md,0,sizeof(\*md)); |
|  |  |
|  | pol = \_\_get\_vma\_policy(vma, vma->vm\_start,&ilx); |
|  | if(pol){ |
|  | mpol\_to\_str(buffer,sizeof(buffer), pol); |
|  | mpol\_cond\_put(pol); |
|  | }else{ |
|  | mpol\_to\_str(buffer,sizeof(buffer), proc\_priv->task\_mempolicy); |
|  | } |
|  |  |
|  | seq\_printf(m,"%08lx %s", vma->vm\_start, buffer); |
|  |  |
|  | if(file){ |
|  | seq\_puts(m," file="); |
|  | seq\_path(m, file\_user\_path(file),"\\n\\t= "); |
|  | }elseif(vma\_is\_initial\_heap(vma)){ |
|  | seq\_puts(m," heap"); |
|  | }elseif(vma\_is\_initial\_stack(vma)){ |
|  | seq\_puts(m," stack"); |
|  | } |
|  |  |
|  | if(is\_vm\_hugetlb\_page(vma)) |
|  | seq\_puts(m," huge"); |
|  |  |
|  | /\\* mmap\_lock is held by m\_start \*/ |
|  | walk\_page\_vma(vma,&show\_numa\_ops, md); |
|  |  |
|  | if(!md->pages) |
|  | goto out; |
|  |  |
|  | if(md->anon) |
|  | seq\_printf(m," anon=%lu", md->anon); |
|  |  |
|  | if(md->dirty) |
|  | seq\_printf(m," dirty=%lu", md->dirty); |
|  |  |
|  | if(md->pages != md->anon && md->pages != md->dirty) |
|  | seq\_printf(m," mapped=%lu", md->pages); |
|  |  |
|  | if(md->mapcount\_max >1) |
|  | seq\_printf(m," mapmax=%lu", md->mapcount\_max); |
|  |  |
|  | if(md->swapcache) |
|  | seq\_printf(m," swapcache=%lu", md->swapcache); |
|  |  |
|  | if(md->active < md->pages &&!is\_vm\_hugetlb\_page(vma)) |
|  | seq\_printf(m," active=%lu", md->active); |
|  |  |
|  | if(md->writeback) |
|  | seq\_printf(m," writeback=%lu", md->writeback); |
|  |  |
|  | for\_each\_node\_state(nid, N\_MEMORY) |
|  | if(md->node\[nid\]) |
|  | seq\_printf(m," N%d=%lu", nid, md->node\[nid\]); |
|  |  |
|  | seq\_printf(m," kernelpagesize\_kB=%lu", vma\_kernel\_pagesize(vma)>>10); |
|  | out: |
|  | seq\_putc(m,'\\n'); |
|  | return0; |
|  | } |
|  |  |
|  | staticconststruct seq\_operations proc\_pid\_numa\_maps\_op ={ |
|  | .start = m\_start, |
|  | .next = m\_next, |
|  | .stop = m\_stop, |
|  | .show = show\_numa\_map, |
|  | }; |
|  |  |
|  | staticint pid\_numa\_maps\_open(struct inode \*inode,struct file \*file) |
|  | { |
|  | return proc\_maps\_open(inode, file,&proc\_pid\_numa\_maps\_op, |
|  | sizeof(struct numa\_maps\_private)); |
|  | } |
|  |  |
|  | conststruct file\_operations proc\_pid\_numa\_maps\_operations ={ |
|  | .open = pid\_numa\_maps\_open, |
|  | .read = seq\_read, |
|  | .llseek = seq\_lseek, |
|  | .release = proc\_map\_release, |
|  | }; |
|  |  |
|  | #endif/\\* CONFIG\_NUMA \*/ |