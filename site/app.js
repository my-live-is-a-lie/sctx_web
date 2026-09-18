const fileInput = document.querySelector("#files");
const convertButton = document.querySelector("#convert");
const downloadAllButton = document.querySelector("#downloadAll");
const downloadBar = document.querySelector("#downloadBar");
const progress = document.querySelector("#progress");
const counter = document.querySelector("#counter");
const current = document.querySelector("#current");
const log = document.querySelector("#log");

let selected = [];
let results = [];

let wasmModule = null;
let wasmPromise = null;

let assimpModule = null;
let assimpPromise = null;

function addLog(text, cls = "") {
  const li = document.createElement("li");
  li.textContent = text;

  if (cls) {
    li.className = cls;
  }

  log.appendChild(li);
}

function outputName(name) {
  return name.replace(/\.sctx$/i, "") + ".png";
}

function baseName(name) {
  return name
    .split("/")
    .pop()
    .replace(/\.(glb|gltf|sctx)$/i, "");
}

function isPng(data) {
  return data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a;
}

/*
 * Load the existing SCTX WebAssembly converter.
 */
function loadWasm() {
  if (wasmModule) {
    return Promise.resolve(wasmModule);
  }

  if (wasmPromise) {
    return wasmPromise;
  }

  wasmPromise = new Promise((resolve, reject) => {
    function initFactory() {
      if (typeof createSctxConverter !== "function") {
        reject(new Error("createSctxConverter is not a function"));
        return;
      }

      createSctxConverter({
        locateFile(filename) {
          return new URL("./wasm/" + filename, import.meta.url).href;
        },
        noInitialRun: true,
        noExitRuntime: true
      }).then(instance => {
        if (!instance.FS || typeof instance.callMain !== "function") {
          reject(new Error("FS or callMain is missing from the SCTX module"));
          return;
        }

        wasmModule = instance;
        resolve(instance);
      }).catch(reject);
    }

    if (typeof createSctxConverter === "function") {
      initFactory();
      return;
    }

    const script = document.createElement("script");
    script.src = new URL("./wasm/SctxConverter.js", import.meta.url).href;
    script.async = true;

    script.onload = initFactory;
    script.onerror = () => {
      reject(new Error("Failed to load SctxConverter.js"));
    };

    document.head.appendChild(script);
  }).catch(error => {
    wasmPromise = null;
    throw error;
  });

  return wasmPromise;
}

/*
 * Load libassimp only when a GLB file is actually converted.
 *
 * libassimp is an Assimp WebAssembly build that can export OBJ,
 * MTL and associated texture files in the browser.
 */
async function loadAssimp() {
  if (assimpModule) {
    return assimpModule;
  }

  if (assimpPromise) {
    return assimpPromise;
  }

  assimpPromise = import(
    "https://esm.sh/libassimp@0.3.0?bundle"
  ).then(module => {
    if (typeof module.convert !== "function") {
      throw new Error("libassimp conversion API is unavailable");
    }

    assimpModule = module;
    return module;
  }).catch(error => {
    assimpPromise = null;
    throw error;
  });

  return assimpPromise;
}

/*
 * Extract SCTX and GLB files from a ZIP.
 */
async function extractSupportedFromZip(file) {
  const zip = await JSZip.loadAsync(file);
  const items = [];

  const promises = [];

  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) {
      return;
    }

    if (!/\.(sctx|glb)$/i.test(relativePath)) {
      return;
    }

    promises.push(
      zipEntry.async("uint8array").then(data => {
        const name = relativePath.split("/").pop();

        items.push({
          name,
          data
        });
      })
    );
  });

  await Promise.all(promises);

  return items;
}

/*
 * Read selected files.
 * Direct .sctx/.glb files and ZIP files are supported.
 */
async function readSelectedFiles(fileList) {
  const items = [];

  for (const file of fileList) {
    if (/\.zip$/i.test(file.name)) {
      addLog(`Extracting ZIP: ${file.name}`, "working");

      const extracted = await extractSupportedFromZip(file);

      if (extracted.length === 0) {
        addLog(
          `No .sctx or .glb files found in ${file.name}`,
          "err"
        );
      } else {
        addLog(
          `Found ${extracted.length} supported file(s) in ${file.name}`,
          "ok"
        );

        items.push(...extracted);
      }

    } else if (/\.(sctx|glb)$/i.test(file.name)) {
      const data = new Uint8Array(
        await file.arrayBuffer()
      );

      items.push({
        name: file.name,
        data
      });
    }
  }

  return items;
}

/*
 * Convert one SCTX to PNG.
 */
async function convertSctx(item, wasm) {
  const id =
    Date.now() +
    "_" +
    Math.random().toString(16).slice(2);

  const input = `/input_${id}.sctx`;
  const output = `/output_${id}.png`;

  try {
    wasm.FS.writeFile(input, item.data);

    const exitCode = wasm.callMain([
      "decode",
      input,
      output,
      "-t"
    ]);

    if (exitCode !== 0 && exitCode !== undefined) {
      throw new Error(
        `SCTX decoder exited with code ${exitCode}`
      );
    }

    const png = wasm.FS.readFile(output);

    if (!isPng(png)) {
      throw new Error(
        "SCTX decoder did not produce a valid PNG"
      );
    }

    results.push({
      name: outputName(item.name),
      files: [
        {
          name: outputName(item.name),
          data: new Uint8Array(png)
        }
      ],
      type: "png"
    });

  } finally {
    try {
      wasm.FS.unlink(input);
    } catch {}

    try {
      wasm.FS.unlink(output);
    } catch {}
  }
}

/*
 * Convert one GLB to an OBJ package.
 *
 * The Assimp OBJ exporter can return multiple files:
 *   model.obj
 *   model.mtl
 *   textures/...
 *
 * They are kept together in the download ZIP.
 */
async function convertGlb(item) {
  const { convert } = await loadAssimp();

  const result = await convert(
    {
      name: item.name,
      bytes: item.data
    },
    {
      to: "obj",
      exportOptions: {
        materials: true
      }
    }
  );

  if (!result || !result.files || result.files.length === 0) {
    throw new Error("GLB to OBJ conversion produced no files");
  }

  const files = result.files.map(file => {
    if (!file || !file.name || !file.bytes) {
      throw new Error("Invalid file returned by GLB converter");
    }

    return {
      name: file.name,
      data: new Uint8Array(file.bytes)
    };
  });

  const objFile = files.find(
    file => /\.obj$/i.test(file.name)
  );

  if (!objFile) {
    throw new Error("GLB converter did not produce an OBJ file");
  }

  const modelName = baseName(item.name);

  results.push({
    name: modelName,
    files,
    type: "obj"
  });
}

/*
 * Create one ZIP containing all converted files.
 *
 * GLB conversions may contain OBJ + MTL + textures.
 * SCTX conversions contain PNG files.
 */
async function downloadResultsAsZip() {
  if (results.length === 0) {
    return;
  }

  const zip = new JSZip();

  for (const result of results) {
    const folder =
      results.length > 1
        ? zip.folder(result.name)
        : zip;

    for (const file of result.files) {
      folder.file(file.name, file.data);
    }
  }

  const content = await zip.generateAsync({
    type: "blob"
  });

  const url = URL.createObjectURL(content);

  const a = document.createElement("a");
  a.href = url;
  a.download =
    results.length === 1
      ? `${results[0].name}_converted.zip`
      : `converted_${results.length}_files.zip`;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 2000);
}

fileInput.addEventListener("change", async () => {
  selected = [];
  results = [];

  log.innerHTML = "";
  progress.style.width = "0%";

  downloadBar.classList.add("hidden");
  downloadAllButton.disabled = true;

  current.textContent = "Reading files…";

  try {
    selected = await readSelectedFiles([
      ...fileInput.files
    ]);

    counter.textContent =
      `0 / ${selected.length}`;

    current.textContent = selected.length
      ? `${selected.length} file(s) ready`
      : "Ready";

    convertButton.disabled =
      selected.length === 0;

  } catch (error) {
    console.error(error);

    addLog(
      `✗ ${error.message || error}`,
      "err"
    );

    current.textContent =
      "Failed to read files";

    convertButton.disabled = true;
  }
});

convertButton.addEventListener("click", async () => {
  if (!selected.length) {
    return;
  }

  convertButton.disabled = true;
  fileInput.disabled = true;

  results = [];
  log.innerHTML = "";

  downloadBar.classList.add("hidden");
  downloadAllButton.disabled = true;

  try {
    let wasm = null;
    let assimp = null;

    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const n = i + 1;

      counter.textContent =
        `${i} / ${selected.length}`;

      current.textContent =
        `Converting: ${item.name}`;

      addLog(
        `Converting: ${item.name}`,
        "working"
      );

      try {
        if (/\.sctx$/i.test(item.name)) {
          if (!wasm) {
            current.textContent =
              "Loading SCTX decoder…";

            addLog(
              "Loading SCTX WebAssembly decoder…",
              "working"
            );

            wasm = await loadWasm();
          }

          await convertSctx(item, wasm);

          addLog(
            `✓ ${outputName(item.name)}`,
            "ok"
          );

        } else if (/\.glb$/i.test(item.name)) {
          if (!assimp) {
            current.textContent =
              "Loading GLB → OBJ converter…";

            addLog(
              "Loading GLB → OBJ WebAssembly converter…",
              "working"
            );

            assimp = await loadAssimp();
          }

          await convertGlb(item);

          addLog(
            `✓ ${baseName(item.name)}.obj`,
            "ok"
          );

        } else {
          throw new Error(
            "Unsupported file type"
          );
        }

      } catch (error) {
        console.error(error);

        addLog(
          `✗ ${item.name} — ${
            error?.message || error
          }`,
          "err"
        );
      }

      counter.textContent =
        `${n} / ${selected.length}`;

      progress.style.width =
        `${Math.round(
          (n / selected.length) * 100
        )}%`;
    }

    current.textContent =
      `Done — ${results.length} conversion(s)`;

    if (results.length > 0) {
      downloadAllButton.disabled = false;
      downloadBar.classList.remove("hidden");

      downloadAllButton.textContent =
        results.some(result => result.type === "obj")
          ? "Download converted files (ZIP)"
          : "Download PNGs (ZIP)";
    }

  } catch (error) {
    console.error(error);

    addLog(
      `✗ ${error?.message || error}`,
      "err"
    );

    current.textContent =
      "Conversion failed";

  } finally {
    convertButton.disabled =
      selected.length === 0;

    fileInput.disabled = false;
  }
});

downloadAllButton.addEventListener(
  "click",
  async () => {
    downloadAllButton.disabled = true;
    downloadAllButton.textContent =
      "Preparing ZIP…";

    try {
      await downloadResultsAsZip();

    } catch (error) {
      console.error(error);

      addLog(
        `✗ Failed to create ZIP: ${
          error.message || error
        }`,
        "err"
      );

    } finally {
      downloadAllButton.disabled =
        results.length === 0;

      downloadAllButton.textContent =
        results.some(result => result.type === "obj")
          ? "Download converted files (ZIP)"
          : "Download PNGs (ZIP)";
    }
  }
);
