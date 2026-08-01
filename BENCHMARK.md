# The State of CI Waste

> **⚠️ WITHDRAWN — being regenerated.**
>
> The first version of this report contained a significant error. Broken-window
> findings ("a job red for N runs in a row") were computed without resetting the
> streak on successful runs, because the analyzer never fetches jobs for runs
> that passed. The published counts were therefore *total failures in the
> window*, not *consecutive* failures — a much weaker and quite different claim.
>
> It was caught by independently checking the largest finding: `opencv/opencv`'s
> `Windows (x64, base, 5.x)` job was reported as 60 consecutive failures, but
> actually passes and fails alternately across unrelated pull-request branches.
>
> Broken windows accounted for roughly 29% of the withdrawn headline figure, so
> the corrected total will be materially lower. The bug is fixed and covered by
> regression tests; this file will be replaced once the corpus is re-analysed.
