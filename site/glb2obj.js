// Browser-only GLB -> OBJ/MTL converter.
// No external CDN or WebAssembly dependency.

function readU32(view, offset) {
  return view.getUint32(offset, true);
}

function readF32(view, offset) {
  return view.getFloat32(offset, true);
}

function componentInfo(componentType) {
  switch (componentType) {
    case 5120: return { size: 1, getter: (v, o) => v.getInt8(o) };
    case 5121: return { size: 1, getter: (v, o) => v.getUint8(o) };
    case 5122: return { size: 2, getter: (v, o) => v.getInt16(o, true) };
    case 5123: return { size: 2, getter: (v, o) => v.getUint16(o, true) };
    case 5125: return { size: 4, getter: (v, o) => v.getUint32(o, true) };
    case 5126: return { size: 4, getter: (v, o) => v.getFloat32(o, true) };
    default: throw new Error(`Unsupported glTF component type: ${componentType}`);
  }
}

function typeCount(type) {
  switch (type) {
    case "SCALAR": return 1;
    case "VEC2": return 2;
    case "VEC3": return 3;
    case "VEC4": return 4;
    case "MAT2": return 4;
    case "MAT3": return 9;
    case "MAT4": return 16;
    default: throw new Error(`Unsupported glTF accessor type: ${type}`);
  }
}

function parseGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 20 || readU32(view, 0) !== 0x46546c67) {
    throw new Error("Not a valid GLB file");
  }

  const version = readU32(view, 4);
  if (version !== 2) throw new Error(`Unsupported GLB version: ${version}`);

  const totalLength = readU32(view, 8);
  if (totalLength > view.byteLength) throw new Error("Truncated GLB file");

  let offset = 12;
  let json = null;
  let bin = new Uint8Array(0);

  while (offset + 8 <= totalLength) {
    const chunkLength = readU32(view, offset);
    const chunkType = readU32(view, offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > totalLength) throw new Error("Invalid GLB chunk length");

    const chunk = bytes.subarray(start, end);
    if (chunkType === 0x4E4F534A) {
      json = JSON.parse(new TextDecoder().decode(chunk).replace(/\u0000+$/g, "").trim());
    } else if (chunkType === 0x004E4942) {
      bin = chunk;
    }
    offset = end;
  }

  if (!json) throw new Error("GLB JSON chunk is missing");
  return { json, bin };
}

function getBufferBytes(gltf, bin, bufferIndex) {
  const buffer = gltf.buffers?.[bufferIndex];
  if (!buffer) throw new Error(`Missing buffer ${bufferIndex}`);
  if (buffer.uri) {
    if (!buffer.uri.startsWith("data:")) {
      throw new Error("External glTF buffers are not supported inside GLB");
    }
    const comma = buffer.uri.indexOf(",");
    const encoded = buffer.uri.slice(comma + 1);
    const raw = atob(encoded);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  return bin;
}

function readAccessor(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);

  const count = accessor.count;
  const components = typeCount(accessor.type);
  const info = componentInfo(accessor.componentType);
  const result = new Array(count);

  if (accessor.bufferView === undefined) {
    const zeros = new Array(components).fill(0);
    for (let i = 0; i < count; i++) result[i] = zeros.slice();
    return result;
  }

  const bv = gltf.bufferViews[accessor.bufferView];
  const buffer = getBufferBytes(gltf, bin, bv.buffer);
  const stride = bv.byteStride || info.size * components;
  const base = (bv.byteOffset || 0) + (accessor.byteOffset || 0);
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let i = 0; i < count; i++) {
    const values = new Array(components);
    const itemOffset = base + i * stride;
    for (let c = 0; c < components; c++) {
      values[c] = info.getter(dv, itemOffset + c * info.size);
    }

    if (accessor.normalized) {
      for (let c = 0; c < components; c++) {
        if (accessor.componentType === 5120) values[c] = Math.max(values[c] / 127, -1);
        else if (accessor.componentType === 5121) values[c] /= 255;
        else if (accessor.componentType === 5122) values[c] = Math.max(values[c] / 32767, -1);
        else if (accessor.componentType === 5123) values[c] /= 65535;
      }
    }
    result[i] = values;
  }

  if (accessor.sparse) {
    // Sparse accessors are uncommon in game GLBs, but handle them rather than silently corrupting data.
    const sparse = accessor.sparse;
    const indexInfo = componentInfo(sparse.indices.componentType);
    const indexView = gltf.bufferViews[sparse.indices.bufferView];
    const indexBuffer = getBufferBytes(gltf, bin, indexView.buffer);
    const indexDv = new DataView(indexBuffer.buffer, indexBuffer.byteOffset, indexBuffer.byteLength);
    const indexBase = (indexView.byteOffset || 0) + (sparse.indices.byteOffset || 0);

    const valueView = gltf.bufferViews[sparse.values.bufferView];
    const valueBuffer = getBufferBytes(gltf, bin, valueView.buffer);
    const valueDv = new DataView(valueBuffer.buffer, valueBuffer.byteOffset, valueBuffer.byteLength);
    const valueBase = (valueView.byteOffset || 0) + (sparse.values.byteOffset || 0);

    for (let i = 0; i < sparse.count; i++) {
      const idx = indexInfo.getter(indexDv, indexBase + i * indexInfo.size);
      const values = new Array(components);
      for (let c = 0; c < components; c++) {
        values[c] = info.getter(valueDv, valueBase + (i * components + c) * info.size);
      }
      result[idx] = values;
    }
  }

  return result;
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URI");
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (!/;base64/i.test(meta)) throw new Error("Only base64 data URIs are supported for textures");
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, mime: meta.split(";")[0] || "application/octet-stream" };
}

function extensionForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/ktx2") return "ktx2";
  if (mime === "image/bmp") return "bmp";
  return "bin";
}

function imageFile(gltf, bin, imageIndex) {
  const image = gltf.images?.[imageIndex];
  if (!image) return null;

  if (image.uri) return decodeDataUri(image.uri);
  if (image.bufferView !== undefined) {
    const bv = gltf.bufferViews[image.bufferView];
    const buffer = getBufferBytes(gltf, bin, bv.buffer);
    const start = bv.byteOffset || 0;
    const end = start + bv.byteLength;
    return { bytes: buffer.slice(start, end), mime: image.mimeType || "application/octet-stream" };
  }
  return null;
}

function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

function transformDirection(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const a = [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z
  ];
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();

  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

function fmt(n) {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return "0";
  return Number(n.toFixed(7)).toString();
}

function materialInfo(gltf, materialIndex) {
  const material = gltf.materials?.[materialIndex] || {};
  const pbr = material.pbrMetallicRoughness || {};
  const base = pbr.baseColorFactor || [1, 1, 1, 1];
  return {
    name: (material.name || `material_${materialIndex ?? 0}`).replace(/[^a-zA-Z0-9_.-]+/g, "_"),
    diffuse: base.slice(0, 3),
    alpha: base[3] ?? 1,
    textureIndex: pbr.baseColorTexture?.index
  };
}

export function convertGlbToObj(bytes, originalName) {
  const { json: gltf, bin } = parseGLB(bytes);
  const vertices = [];
  const normals = [];
  const uvs = [];
  const faces = [];
  const materials = new Map();
  const textureRefs = new Map();
  const nodes = gltf.nodes || [];
  const scenes = gltf.scenes || [];
  const sceneIndex = gltf.scene ?? 0;

  const roots = scenes[sceneIndex]?.nodes || nodes.map((_, i) => i).filter(i => !nodes.some(n => (n.children || []).includes(i)));

  function visitNode(nodeIndex, parentMatrix) {
    const node = nodes[nodeIndex] || {};
    const world = multiply4(parentMatrix, nodeMatrix(node));
    if (node.mesh !== undefined) emitMesh(node.mesh, world);
    for (const child of node.children || []) visitNode(child, world);
  }

  function emitMesh(meshIndex, matrix) {
    const mesh = gltf.meshes?.[meshIndex];
    if (!mesh) return;

    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue; // triangles only
      if (primitive.attributes?.POSITION === undefined) continue;

      const positions = readAccessor(gltf, bin, primitive.attributes.POSITION);
      const normalData = primitive.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, primitive.attributes.NORMAL) : null;
      const uvData = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, primitive.attributes.TEXCOORD_0) : null;
      const indices = primitive.indices !== undefined
        ? readAccessor(gltf, bin, primitive.indices).map(v => v[0])
        : positions.map((_, i) => i);

      const baseIndex = vertices.length + 1;
      for (let i = 0; i < positions.length; i++) {
        vertices.push(transformPoint(matrix, positions[i]));
        normals.push(normalData ? transformDirection(matrix, normalData[i]) : null);
        uvs.push(uvData ? [uvData[i][0], 1 - uvData[i][1]] : null);
      }

      const materialIndex = primitive.material ?? 0;
      const mat = materialInfo(gltf, materialIndex);
      materials.set(mat.name, mat);

      if (mat.textureIndex !== undefined && !textureRefs.has(mat.name)) {
        const texture = gltf.textures?.[mat.textureIndex];
        if (texture?.source !== undefined) textureRefs.set(mat.name, texture.source);
      }

      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = baseIndex + indices[i];
        const b = baseIndex + indices[i + 1];
        const c = baseIndex + indices[i + 2];
        faces.push({ a, b, c, material: mat.name });
      }
    }
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of roots) visitNode(root, identity);

  if (!vertices.length || !faces.length) throw new Error("GLB contains no triangle geometry");

  const base = originalName.replace(/\.glb$/i, "").replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const objName = `${base}.obj`;
  const mtlName = `${base}.mtl`;
  const outputFiles = [];

  const imageOutputs = new Map();
  for (const [materialName, imageIndex] of textureRefs) {
    const image = imageFile(gltf, bin, imageIndex);
    if (!image) continue;
    const ext = extensionForMime(image.mime);
    const textureName = `${base}_texture_${imageIndex}.${ext}`;
    imageOutputs.set(imageIndex, textureName);
    outputFiles.push({ name: textureName, data: image.bytes });
  }

  const mtl = [`# Generated from ${originalName}`];
  for (const mat of materials.values()) {
    mtl.push(`newmtl ${mat.name}`);
    mtl.push(`Kd ${fmt(mat.diffuse[0])} ${fmt(mat.diffuse[1])} ${fmt(mat.diffuse[2])}`);
    mtl.push(`d ${fmt(mat.alpha)}`);
    if (mat.alpha < 1) mtl.push("Tr 1");
    const imageIndex = textureRefs.get(mat.name);
    if (imageIndex !== undefined && imageOutputs.has(imageIndex)) {
      mtl.push(`map_Kd ${imageOutputs.get(imageIndex)}`);
    }
    mtl.push("");
  }

  const obj = [`# Generated from ${originalName}`, `mtllib ${mtlName}`];
  for (const v of vertices) obj.push(`v ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
  for (const uv of uvs) if (uv) obj.push(`vt ${fmt(uv[0])} ${fmt(uv[1])}`); else obj.push("vt 0 0");
  for (const n of normals) if (n) obj.push(`vn ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`); else obj.push("vn 0 0 1");

  let currentMaterial = null;
  for (const f of faces) {
    if (f.material !== currentMaterial) {
      obj.push(`usemtl ${f.material}`);
      currentMaterial = f.material;
    }
    obj.push(`f ${f.a}/${f.a}/${f.a} ${f.b}/${f.b}/${f.b} ${f.c}/${f.c}/${f.c}`);
  }

  outputFiles.unshift({ name: objName, data: new TextEncoder().encode(obj.join("\n") + "\n") });
  outputFiles.splice(1, 0, { name: mtlName, data: new TextEncoder().encode(mtl.join("\n") + "\n") });

  return { name: base, files: outputFiles };
}
