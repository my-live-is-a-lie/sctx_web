import { convertGlbToObj } from "./glb2obj.js";

const fileInput = document.querySelector("#files");
const convertButton = document.querySelector("#convert");
const downloadAllButton = document.querySelector("#downloadAll");
const downloadBar = document.querySelector("#downloadBar");
const supercellOutput = document.querySelector("#supercellOutput");
const progress = document.querySelector("#progress");
const counter = document.querySelector("#counter");
const current = document.querySelector("#current");
const log = document.querySelector("#log");

let selected = [];
let results = [];

let wasmModule = null;
let wasmPromise = null;
let pyodide = null;
let pyodidePromise = null;
let supercellConverterPromise = null;

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

function isStandardGlb(data) {
  return data.length >= 20 &&
    data[0] === 0x67 && data[1] === 0x6c &&
    data[2] === 0x54 && data[3] === 0x46 &&
    data[16] === 0x4a && data[17] === 0x53 &&
    data[18] === 0x4f && data[19] === 0x4e;
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

function isSupercellGlb(data) {
  return data.length >= 20 &&
    data[0] === 0x67 && data[1] === 0x6c &&
    data[2] === 0x54 && data[3] === 0x46 &&
    data[16] === 0x46 && data[17] === 0x4c &&
    data[18] === 0x41 && data[19] === 0x32;
}

async function loadSupercellConverter() {
  if (supercellConverterPromise) return supercellConverterPromise;

  supercellConverterPromise = (async () => {
    if (!pyodide) {
      if (!pyodidePromise) {
        pyodidePromise = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/pyodide/v0.28.2/full/pyodide.js";
          script.onload = async () => {
            try {
              resolve(await loadPyodide({
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.28.2/full/"
              }));
            } catch (error) {
              reject(error);
            }
          };
          script.onerror = () => reject(new Error("Failed to load Pyodide"));
          document.head.appendChild(script);
        });
      }

      pyodide = await pyodidePromise;
      await pyodide.loadPackage(["numpy", "micropip"]);
      await pyodide.runPythonAsync(
        "import micropip\nawait micropip.install('flatbuffers')"
      );

      const files = [
        "__init__.py", "convert.py", "binary_reader/__init__.py",
        "binary_reader/binary_reader.py", "lib/__init__.py",
        "lib/flatbuffer.py", "lib/glTF.py", "lib/gltf_constants.py",
        "lib/odin.py", "lib/odin_attribute.py", "lib/odin_constants.py",
        "lib/animation/__init__.py", "lib/animation/continuousPackedReader.py",
        "lib/animation/flags.py", "lib/animation/packedReader.py",
        "lib/animation/rawReader.py", "lib/animation/reader.py",
        "lib/generated/__init__.py", "lib/generated/glTF_generated.py"
      ];

      for (const file of files) {
        const response = await fetch(new URL(`./supercell_converter/${file}`, import.meta.url));
        if (!response.ok) throw new Error(`Failed to load ${file}`);
        const content = new Uint8Array(await response.arrayBuffer());
        const target = `/site/supercell_converter/${file}`;
        pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
        pyodide.FS.writeFile(target, content);
      }

      pyodide.runPython(
        "import sys\nsys.path.insert(0, '/site')\nsys.path.insert(0, '/site/supercell_converter')"
      );
      await pyodide.runPythonAsync(
        "from supercell_converter.convert import convert_supercell_glb"
      );
    }
    return pyodide;
  })().catch(error => {
    supercellConverterPromise = null;
    throw error;
  });

  return supercellConverterPromise;
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
  let converted;

  if (isSupercellGlb(item.data)) {
    const runtime = await loadSupercellConverter();
    const input = runtime.toPy(item.data);
    runtime.globals.set("supercellInput", input);
    const outputProxy = runtime.runPython(
      "convert_supercell_glb(bytes(supercellInput))"
    );
    const output = outputProxy.toJs();
    outputProxy.destroy();
    runtime.globals.delete("supercellInput");
    input.destroy();
    const standardGlb = new Uint8Array(output);
    if (!isStandardGlb(standardGlb)) {
      throw new Error("Supercell converter did not produce a standard GLB");
    }

    if (supercellOutput.value === "glb") {
      const name = `${baseName(item.name)}.glb`;
      results.push({
        name: baseName(item.name),
        files: [{ name, data: standardGlb }],
        type: "glb"
      });
      return;
    }

    converted = convertGlbToObj(standardGlb, item.name);
  } else {
    converted = convertGlbToObj(item.data, item.name);
  }

  if (!converted || !converted.files || converted.files.length === 0) {
    throw new Error("GLB to OBJ conversion produced no files");
  }

  const objFile = converted.files.find(
    file => /\.obj$/i.test(file.name)
  );

  if (!objFile) {
    throw new Error("GLB converter did not produce an OBJ file");
  }

  results.push({
    name: converted.name,
    files: converted.files,
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
  let failures = 0;
  current.classList.remove("ok", "err");

  downloadBar.classList.add("hidden");
  downloadAllButton.disabled = true;

  try {
    let wasm = null;

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
          current.textContent =
            "Converting GLB → OBJ locally…";

          await convertGlb(item);

          addLog(
            `✓ ${baseName(item.name)}.${supercellOutput.value === "glb" && isSupercellGlb(item.data) ? "glb" : "obj"}`,
            "ok"
          );

        } else {
          throw new Error(
            "Unsupported file type"
          );
        }

      } catch (error) {
        console.error(error);
        failures += 1;
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

    current.classList.remove("ok", "err");
    current.classList.add(failures > 0 ? "err" : "ok");
    current.textContent = failures > 0
      ? `${failures} failed — Done ${results.length}`
      : `Done — ${results.length} conversion(s)`;

    if (results.length > 0) {
      downloadAllButton.disabled = false;
      downloadBar.classList.remove("hidden");

      downloadAllButton.textContent =
        results.some(result => result.type === "obj")
          ? "Download OBJ files (ZIP)"
          : results.some(result => result.type === "glb")
            ? "Download GLB files (ZIP)"
            : "Download PNGs (ZIP)";
    }

  } catch (error) {
    console.error(error);

    addLog(
      `✗ ${error?.message || error}`,
      "err"
    );

    current.classList.remove("ok");
    current.classList.add("err");
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
          ? "Download OBJ files (ZIP)"
          : results.some(result => result.type === "glb")
            ? "Download GLB files (ZIP)"
            : "Download PNGs (ZIP)";
    }
  }
);
