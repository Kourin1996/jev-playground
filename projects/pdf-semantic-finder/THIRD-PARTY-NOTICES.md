# Third-party notices

Components and assets in this repository that were written elsewhere, with the notices their
licences require carried with them.

## Untitled UI React

`src/components/base/` and `src/components/application/` are taken from
[untitleduico/react](https://github.com/untitleduico/react) and modified for this project.

Every file in those two directories is present in that repository, which is the open-source half of
Untitled UI React and is MIT licensed. The PRO product is a separate distribution under a separate
agreement and none of it is here — checked file by file against the repository's tree before this
repository was made public, because the two halves share directory names and the licence turns
entirely on which half a file came from.

The icon packages `@untitledui/icons` and `@untitledui/file-icons` are separate MIT-licensed npm
dependencies and are not vendored.

```
MIT License

Copyright (c) 2025 Untitled UI

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

## The Bitcoin whitepaper

`assets/bitcoin.pdf` and `tests/fixtures/bitcoin.pdf` are Satoshi Nakamoto's "Bitcoin: A
Peer-to-Peer Electronic Cash System", which is distributed with Bitcoin Core under the MIT licence.
It is used here as a test fixture and as the document a demonstration opens.

## PDF.js

`pdfjs-dist` is an npm dependency under the Apache License 2.0. Its runtime assets — CMaps, standard
fonts, WASM and ICC profiles — are copied into `public/pdfjs/` at install time by
`scripts/copy-pdfjs-assets.mjs` and are gitignored rather than committed, so they are not
redistributed by this repository.
