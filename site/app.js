const fileInput = document.querySelector("#files");
const convertButton = document.querySelector("#convert");
const downloadAllButton = document.querySelector("#downloadAll");
const downloadBar = document.querySelector("#downloadBar");
const progress = document.querySelector("#progress");
const counter = document.querySelector("#counter");
const current = document.querySelector("#current");
const log = document.querySelector("#log");

let selected = [];   // Array of { name, data: Uint8Array }
let results = [];    // Array of { name, blob }
let wasmModule = null;
let wasmPromise = null;

function addLog(text, cls = "") {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  log.appendChild(li);
}

function outputName(name) {
  return name.replace(/\.sctx$/i, "") + ".png";
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

/**
 * Load the modularized Emscripten factory
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
          reject(new Error("FS or callMain is missing from the module"));
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

    script.onload = () => initFactory();
    script.onerror = () => reject(new Error("Failed to load SctxConverter.js"));

    document.head.appendChild(script);
  }).catch(err => {
    wasmPromise = null;
    throw err;
  });

  return wasmPromise;
}

/**
 * Extract .sctx files from a ZIP
 */
async function extractSctxFromZip(file) {
  const zip = await JSZip.loadAsync(file);
  const items = [];

  const promises = [];
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    if (!/\.sctx$/i.test(relativePath)) return;

    promises.push(
      zipEntry.async("uint8array").then(data => {
        // Keep only the filename (not full path)
        const name = relativePath.split("/").pop();
        items.push({ name, data });
      })
    );
  });

  await Promise.all(promises);
  return items;
}

/**
 * Read selected files (supports .sctx and .zip)
 */
async function readSelectedFiles(fileList) {
  const items = [];

  for (const file of fileList) {
    if (/\.zip$/i.test(file.name)) {
      addLog(`Extracting ZIP: ${file.name}`, "working");
      const extracted = await extractSctxFromZip(file);
      if (extracted.length === 0) {
        addLog(`No .sctx files found in ${file.name}`, "err");
      } else {
        addLog(`Found ${extracted.length} .sctx file(s) in ${file.name}`, "ok");
        items.push(...extracted);
      }
    } else if (/\.sctx$/i.test(file.name)) {
      const data = new Uint8Array(await file.arrayBuffer());
      items.push({ name: file.name, data });
    }
  }

  return items;
}

async function convertOne(item, wasm) {
  const id = Date.now() + "_" + Math.random().toString(16).slice(2);
  const input = "/input_" + id + ".sctx";
  const output = "/output_" + id + ".png";

  try {
    wasm.FS.writeFile(input, item.data);

    const exitCode = wasm.callMain([
      "decode",
      input,
      output,
      "-t"
    ]);

    if (exitCode !== 0 && exitCode !== undefined) {
      throw new Error(`Decoder exited with code ${exitCode}`);
    }

    const png = wasm.FS.readFile(output);

    if (!isPng(png)) {
      throw new Error("Decoder did not produce a valid PNG");
    }

    results.push({
      name: outputName(item.name),
      blob: new Blob([png], { type: "image/png" })
    });

  } finally {
    try { wasm.FS.unlink(input); } catch {}
    try { wasm.FS.unlink(output); } catch {}
  }
}

/**
 * Create a ZIP from all results and trigger download
 */
async function downloadResultsAsZip() {
  if (results.length === 0) return;

  const zip = new JSZip();

  for (const item of results) {
    zip.file(item.name, item.blob);
  }

  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);

  const a = document.createElement("a");
  a.href = url;
  a.download = results.length === 1
    ? results[0].name
    : `sctx_converted_${results.length}_files.zip`;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
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
    selected = await readSelectedFiles([...fileInput.files]);

    counter.textContent = `0 / ${selected.length}`;
    current.textContent = selected.length
      ? `${selected.length} file(s) ready`
      : "Ready";

    convertButton.disabled = selected.length === 0;
  } catch (err) {
    console.error(err);
    addLog(`✗ ${err.message || err}`, "err");
    current.textContent = "Failed to read files";
    convertButton.disabled = true;
  }
});

convertButton.addEventListener("click", async () => {
  if (!selected.length) return;

  convertButton.disabled = true;
  fileInput.disabled = true;
  results = [];
  log.innerHTML = "";
  downloadBar.classList.add("hidden");

  try {
    current.textContent = "Loading decoder…";
    addLog("Loading WebAssembly decoder…", "working");

    const wasm = await loadWasm();

    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const n = i + 1;

      counter.textContent = `${i} / ${selected.length}`;
      current.textContent = `Converting: ${item.name}`;
      addLog(`Converting: ${item.name}`, "working");

      try {
        await convertOne(item, wasm);
        addLog(`✓ ${outputName(item.name)}`, "ok");
      } catch (error) {
        console.error(error);
        addLog(`✗ ${item.name} — ${error?.message || error}`, "err");
      }

      counter.textContent = `${n} / ${selected.length}`;
      progress.style.width = `${Math.round((n / selected.length) * 100)}%`;
    }

    current.textContent = `Done — ${results.length} PNG(s)`;

    if (results.length > 0) {
      downloadAllButton.disabled = false;
      downloadBar.classList.remove("hidden");
      downloadAllButton.textContent = results.length === 1
        ? "Download PNG"
        : `Download ZIP (${results.length} files)`;
    }

  } catch (error) {
    console.error(error);
    addLog(`✗ ${error?.message || error}`, "err");
    current.textContent = "Conversion failed";
  } finally {
    convertButton.disabled = selected.length === 0;
    fileInput.disabled = false;
  }
});

downloadAllButton.addEventListener("click", async () => {
  downloadAllButton.disabled = true;
  downloadAllButton.textContent = "Preparing ZIP…";

  try {
    await downloadResultsAsZip();
  } catch (err) {
    console.error(err);
    addLog(`✗ Failed to create ZIP: ${err.message}`, "err");
  } finally {
    downloadAllButton.disabled = false;
    downloadAllButton.textContent = results.length === 1
      ? "Download PNG"
      : `Download ZIP (${results.length} files)`;
  }
});