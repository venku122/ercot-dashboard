# Shared canonical tile transport bound

Mixed physical and paired loads previously created separate eight-worker loops, allowing sixteen simultaneous canonical tile GETs. A shared eight-permit transport limiter now surrounds the canonical cache's actual shared tile loader. Cache hits and duplicate subscribers consume no additional permits; default and opted-in catalog requests remain separate cache representations.

Queued shared requests leave the queue when their shared controller aborts. Canceling one subscriber keeps a transport required by another subscriber. Completed and failed transports release permits, including an abort after a queue grant. The existing per-load planning bounds remain in place.

A genuine thirty-day mixed physical/paired integration regression first measured peak sixteen GETs, then verifies peak at most eight. Additional regressions cover queued cancellation without permit leakage, a surviving singleflight subscriber, failure/retry, and pre-aborted requests.
