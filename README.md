# SCTX → PNG / GLB → OBJ Web Converter

Browser-side converter for Supercell SCTX textures and GLB models.

## Supported

- `.sctx` → `.png` using the original SCTX-Converter WebAssembly build.
- Standard `.glb` → `.obj` using a local browser-side GLB parser.
- Supercell Odin `.glb` files with an `FLA2` FlatBuffers chunk are decoded in-browser to standard glTF first, then exported to OBJ.
- For Supercell Odin files, the interface lets you choose between a standard `.glb` file and an `.obj` package.
- ZIP input containing `.sctx` and/or `.glb` files.
- OBJ conversion exports an `.obj`, `.mtl`, and embedded texture files when the GLB contains supported image data.
- Converted files are downloaded together as a ZIP.

## Privacy

Conversion happens locally in the browser. No model or texture is uploaded to a conversion server.

The site does not upload model data to a conversion server. The standard converter and JavaScript dependencies are copied into `site/` by GitHub Actions. Supercell Odin support loads the Pyodide runtime and its NumPy/FlatBuffers packages from the Pyodide CDN on first use; the selected model bytes remain in the browser. The required BinaryReader helper is bundled locally because it is not available as a Pyodide wheel.

## SCTX source

https://github.com/Daniil-SV/SCTX-Converter

## GLB/OBJ limitations

OBJ cannot preserve a GLB rig, skinning, animation, morph-target animation, or all PBR material properties. Geometry, node transforms, normals, UV coordinates, base-color materials, and embedded PNG/JPEG/WebP/KTX2 image bytes are exported when present.
