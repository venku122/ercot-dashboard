# Scoped ERP-02 WebKit visual review

Remote run37176680938 differed by251pixels in the iPhone Pro Max Inspect supply/demand snapshot. Expected, actual and difference images were inspected: the sole meaningful difference is the deliberately dashed hourly forecast stroke. Actual observation geometry, values, controls and containment are unchanged. The single Ubuntu CI WebKit `mobile-inspect-portrait` baseline now records that semantic distinction. Other snapshots and all tolerances are unchanged. The original failed run remains evidence; an exact-head rerun is required.

The first scoped update mistakenly targeted the ordinary Linux filename. CI uses `linux-ubuntu-24.04`; the ordinary Linux file is restored to its original baseline, and only the reviewed CI image is changed. Both failed remote runs are retained.
