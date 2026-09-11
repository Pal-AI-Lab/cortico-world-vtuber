# Third-party notices

## Runtime binaries (not in version control)

`src/voxcpm2-server/bin/` is ignored by Git. It is present only where the TTS server binary has
been built or copied in by the deployer.

### llama.cpp-omni

- Upstream: [tc-mb/llama.cpp-omni](https://github.com/tc-mb/llama.cpp-omni)
- Project fork: [Phantivia/llama.cpp-omni](https://github.com/Phantivia/llama.cpp-omni)
- Current binary's reported base commit:
  `74699a53df6ca0f4947ff37066f851532c20b12d`
- License: MIT
- Copyright: Copyright (c) 2023-2026 The ggml authors
- Bundle destination: `src/voxcpm2-server/bin/`

The current binary was built from a locally modified source tree. It must not be released until
the exact source is committed to the project fork and the notice records that reproducible
commit instead of the base commit above.

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

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

## Live2D models

No Live2D model assets are part of this package. `src/models/examples/cortico.profile.json` is a
wiring profile written for the Type-H1 model as a reading example; the model itself is subject
to its own license and is never distributed here.
