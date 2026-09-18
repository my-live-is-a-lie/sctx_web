# SCTX → PNG / GLB → OBJ Web Converter

Browser-side converter for Supercell SCTX textures and GLB models.

## Supported

- `.sctx` → `.png` using the original SCTX-Converter WebAssembly build.
- `.glb` → `.obj` using a local browser-side GLB parser.
- ZIP input containing `.sctx` and/or `.glb` files.
- OBJ conversion exports an `.obj`, `.mtl`, and embedded texture files when the GLB contains supported image data.
- Converted files are downloaded together as a ZIP.

## Privacy

Conversion happens locally in the browser. No model or texture is uploaded to a conversion server.

The site does not load the GLB converter from `esm.sh` or another runtime CDN. JavaScript dependencies needed by the page are copied into `site/vendor/` by GitHub Actions.

## SCTX source

https://github.com/Daniil-SV/SCTX-Converter

## GLB/OBJ limitations

OBJ cannot preserve a GLB rig, skinning, animation, morph-target animation, or all PBR material properties. Geometry, node transforms, normals, UV coordinates, base-color materials, and embedded PNG/JPEG/WebP/KTX2 image bytes are exported when present.
