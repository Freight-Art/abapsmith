# Third-party notices

This project's ABAP debugger layer (`src/debug/`) and its offline test
fixtures (`test/fixtures/debugger/`) port protocol knowledge — request/response
XML shapes, endpoint paths, query parameters, DDIC field maps — from
[`vibing-steampunk`](https://github.com/oisee/vibing-steampunk) (`vsp`), an
independent, unaffiliated open-source project.

What was ported is protocol knowledge, not code: the wire shapes needed to
speak to the ADT debugger, re-expressed in this project's own TypeScript.

Upstream repository: <https://github.com/oisee/vibing-steampunk>

`vibing-steampunk` is distributed under the MIT License:

```
Copyright (c) 2025-2026 Alice Vinogradova and contributors

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

## Dependencies inlined into `bundle/`

`bundle/index.js` and `bundle/bin/contract.js` are committed, pre-built
single-file builds of `src/index.ts` and `src/bin/contract.ts`. Claude Code
installs a plugin by copying the repository and never runs a build step, so
every runtime dependency has to be resolved ahead of time — the bundler inlines
each one's source directly into those two files. This repository therefore
redistributes the third-party code listed below, and because the build strips
legal comments from the generated output, the notices in this file are what
carry the attribution those licences require.

The list is derived mechanically from the bundler's module graph for both entry
points, so it is the full transitive closure actually inlined, not just the
eight direct dependencies declared in `package.json`. It needs regenerating
whenever `npm run bundle` picks up a changed dependency set.

**Licence status: all 53 inlined packages are under permissive licences (MIT,
ISC, BSD-2-Clause, BSD-3-Clause). None is copyleft — no GPL, LGPL, AGPL or
MPL — and none is missing a licence declaration. Nothing here restricts
redistribution of `bundle/` under this project's own MIT licence.**

### Packages

| Package | Version | Licence (SPDX) |
| --- | --- | --- |
| `@abaplint/core` | 2.120.19 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@nodable/entities` | 3.0.0 | MIT |
| `abap-adt-api` | 8.4.1 | MIT |
| `agent-base` | 6.0.2 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `anynum` | 1.0.1 | MIT |
| `asynckit` | 0.4.0 | MIT |
| `axios` | 1.19.0 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `combined-stream` | 1.0.8 | MIT |
| `debug` | 4.4.3 | MIT |
| `delayed-stream` | 1.0.0 | MIT |
| `dotenv` | 17.4.2 | BSD-2-Clause |
| `dunder-proto` | 1.0.1 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `es-set-tostringtag` | 2.1.0 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.4 | BSD-3-Clause |
| `fast-xml-builder` | 1.3.0 | MIT |
| `fast-xml-parser` | 5.10.1 | MIT |
| `follow-redirects` | 1.16.0 | MIT |
| `form-data` | 4.0.6 | MIT |
| `fp-ts` | 2.16.11 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `gopd` | 1.2.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `has-tostringtag` | 1.0.2 | MIT |
| `hasown` | 2.0.4 | MIT |
| `html-entities` | 2.6.0 | MIT |
| `https-proxy-agent` | 5.0.1 | MIT |
| `io-ts` | 2.2.22 | MIT |
| `io-ts-reporters` | 2.0.1 | MIT |
| `is-unsafe` | 2.0.0 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `json5` | 2.2.3 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `mime-db` | 1.54.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `ms` | 2.1.3 | MIT |
| `path-expression-matcher` | 1.6.2 | MIT |
| `proxy-from-env` | 2.1.0 | MIT |
| `sprintf-js` | 1.1.3 | BSD-3-Clause |
| `strnum` | 2.4.1 | MIT |
| `vscode-languageserver-types` | 3.18.0 | MIT |
| `xml-naming` | 0.3.0 | MIT |
| `zod` | 4.4.3 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

### MIT License

Applies to the following 49 packages, with the copyright holders shown:

- `@abaplint/core` — Lars Hvam Petersen — MIT declared in `package.json`; the published package ships no LICENSE file
- `@modelcontextprotocol/sdk` — Copyright (c) 2024 Anthropic, PBC
- `@nodable/entities` — Amit Gupta / Natural Intelligence — MIT declared in `package.json`; the published package ships no LICENSE file
- `abap-adt-api` — Copyright (c) 2019 Marcello Urbani
- `agent-base` — Copyright (c) 2013 Nathan Rajlich — MIT text in README; the published package ships no LICENSE file
- `ajv` — Copyright (c) 2015-2021 Evgeny Poberezkin
- `ajv-formats` — Copyright (c) 2020 Evgeny Poberezkin
- `anynum` — Copyright (c) 2026 Natural Intelligence
- `asynckit` — Copyright (c) 2016 Alex Indigo
- `axios` — Copyright (c) 2014-present Matt Zabriskie & Collaborators
- `call-bind-apply-helpers` — Copyright (c) 2024 Jordan Harband
- `combined-stream` — Copyright (c) 2011 Debuggable Limited <felix@debuggable.com>
- `debug` — Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon
- `delayed-stream` — Copyright (c) 2011 Debuggable Limited <felix@debuggable.com>
- `dunder-proto` — Copyright (c) 2024 ECMAScript Shims
- `es-define-property` — Copyright (c) 2024 Jordan Harband
- `es-errors` — Copyright (c) 2024 Jordan Harband
- `es-object-atoms` — Copyright (c) 2024 Jordan Harband
- `es-set-tostringtag` — Copyright (c) 2022 ECMAScript Shims
- `fast-deep-equal` — Copyright (c) 2017 Evgeny Poberezkin
- `fast-xml-builder` — Copyright (c) 2026 Natural Intelligence
- `fast-xml-parser` — Copyright (c) 2017 Amit Kumar Gupta
- `follow-redirects` — Copyright 2014–present Olivier Lalonde <olalonde@gmail.com>, James Talmage <james@talmage.io>, Ruben Verborgh
- `form-data` — Copyright (c) 2012 Felix Geisendörfer (felix@debuggable.com) and contributors
- `fp-ts` — Copyright (c) 2017-present Giulio Canti
- `function-bind` — Copyright (c) 2013 Raynos.
- `get-intrinsic` — Copyright (c) 2020 Jordan Harband
- `get-proto` — Copyright (c) 2025 Jordan Harband
- `gopd` — Copyright (c) 2022 Jordan Harband
- `has-symbols` — Copyright (c) 2016 Jordan Harband
- `has-tostringtag` — Copyright (c) 2021 Inspect JS
- `hasown` — Copyright (c) Jordan Harband and contributors
- `html-entities` — Copyright (c) 2021 Dulin Marat
- `https-proxy-agent` — Copyright (c) 2013 Nathan Rajlich — MIT text in README; the published package ships no LICENSE file
- `io-ts` — Copyright (c) 2017 Giulio Canti
- `io-ts-reporters` — Copyright (c) 2017 Oliver Joseph Ash
- `is-unsafe` — Copyright (c) 2026 Natural Intelligence
- `json-schema-traverse` — Copyright (c) 2017 Evgeny Poberezkin
- `json5` — Copyright (c) 2012-2018 Aseem Kishore, and [others].
- `math-intrinsics` — Copyright (c) 2024 ECMAScript Shims
- `mime-db` — Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com>
- `mime-types` — Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>
- `ms` — Copyright (c) 2020 Vercel, Inc.
- `path-expression-matcher` — Copyright (c) 2024 — no holder named in LICENSE; package author is Amit Gupta / Natural Intelligence
- `proxy-from-env` — Copyright (C) 2016-2018 Rob Wu
- `strnum` — Copyright (c) 2021 Natural Intelligence
- `vscode-languageserver-types` — Copyright (c) Microsoft Corporation
- `xml-naming` — Copyright (c) 2026 Natural Intelligence
- `zod` — Copyright (c) 2025 Colin McDonnell

Four of the packages above (`@abaplint/core`, `@nodable/entities`,
`agent-base`, `https-proxy-agent`) declare MIT in `package.json` but ship no
LICENSE file in their published tarball; the holder shown is taken from the
package metadata or its README.

Individual copies differ only in trivial formatting. The licence text, which
applies to each package above under its own copyright notice, is:

```
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

### ISC License

Applies to `zod-to-json-schema`:

```
ISC License

Copyright (c) 2020, Stefan Terdell

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### BSD 2-Clause License

Applies to `dotenv`:

```
Copyright (c) 2015, Scott Motte
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause License

Applies to `fast-uri`:

```
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

Applies to `sprintf-js`:

```
Copyright (c) 2007-present, Alexandru Mărășteanu <hello@alexei.ro>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of this software nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
