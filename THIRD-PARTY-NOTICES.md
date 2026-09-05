# Third-Party Notices

Claude Usage Graph is licensed under the GNU Affero General Public License v3.0.
It bundles the following third-party component into `media/dashboard.js`.

---

## Chart.js

- **Version:** 4.x
- **Homepage:** https://www.chartjs.org/
- **License:** MIT

The MIT License is compatible with the AGPL-3.0: MIT-licensed code may be
incorporated into an AGPL-licensed work, and the combined work is distributed
under the AGPL while this notice preserves Chart.js's own attribution.

```
The MIT License (MIT)

Copyright (c) 2014-2024 Chart.js Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Build-time only

The following are development dependencies. They are not redistributed in the
packaged extension.

| Package | License |
| --- | --- |
| typescript | Apache-2.0 |
| esbuild | MIT |
| mocha | MIT |
| @types/vscode, @types/node, @types/mocha | MIT |

---

## Not bundled

No date-formatting library is included. Chart.js time scales normally require a
date adapter such as `chartjs-adapter-date-fns`; this extension uses a linear
scale with its own tick formatting instead, which avoids shipping `date-fns`
entirely.
