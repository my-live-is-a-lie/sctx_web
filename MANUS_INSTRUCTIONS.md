# Manus AI instructions

Upload this project to:
https://github.com/my-live-is-a-lie/sctx_web

Preserve the directory structure exactly.

Do not replace the SCTX decoder with another implementation.

The decoder must come from:
https://github.com/Daniil-SV/SCTX-Converter

The project should compile the original C++ converter to WebAssembly using Emscripten.

## Upload these files exactly

Create the following structure:

sctx_web/
├── README.md
├── MANUS_INSTRUCTIONS.md
├── .github/
│   └── workflows/
│       └── build-pages.yml
└── site/
    ├── index.html
    ├── style.css
    └── app.js

Do not create placeholder `.wasm` files.

GitHub Actions generates the WebAssembly files automatically.

## GitHub Actions

The workflow:
1. Checks out this repository.
2. Installs Emscripten.
3. Clones SCTX-Converter.
4. Builds SctxConverter.
5. Produces the WebAssembly JavaScript loader and `.wasm` file.
6. Copies them into site/wasm/.
7. Deploys site/ to GitHub Pages.

## Website behavior

The website must:
- allow selecting multiple `.sctx`
- process locally
- never upload SCTX
- use generated WASM decoder
- convert using equivalent of:
  SctxConverter decode input.sctx output.png -t
- display progress `3 / 20`
- display `Converting: maps_03.sctx`
- display successful/failed files
- allow downloading generated PNGs

Do not add server-side conversion, external uploads, Python conversion, another decoder, fake PNG generation, or placeholder logic.

After uploading, commit to main and run:
Actions → Build and deploy SCTX Web

If compilation fails, inspect and fix build config without replacing original decoder.