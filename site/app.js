const fileInput = document.querySelector("#files");
const convertButton = document.querySelector("#convert");
const downloadAllButton = document.querySelector("#downloadAll");
const progress = document.querySelector("#progress");
const counter = document.querySelector("#counter");
const current = document.querySelector("#current");
const log = document.querySelector("#log");

let selected = [];
let results = [];
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
 * Load the modularized Emscripten factory via classic script tag
 */
function loadWasm() {
  if (wasmModule) {
    return Promise.resolve(wasmModule);
  }

  if (wasmPromise) {
    return wasmPromise;
  }

  wasmPromise = new Promise((resolve, reject) => {
    // Already loaded?
    if (typeof createSctxConverter === "function") {
      createSctxConverter({
        locateFile(filename) {
          return new URL("./wasm/" + filename, import.meta.url).href;
        },
        noInitialRun: true,
        noExitRuntime: true
      }).then(instance => {
        if (!instance.FS || typeof instance.callMain !== "function") {
          reject(new Error("FS or callMain is missing"));
          return;
        }
        wasmModule = instance;
        resolve(instance);
      }).catch(reject);
      return;
    }

    const script = document.createElement("script");
    script.src = new URL("./wasm/SctxConverter.js", import.meta.url).href;
    script.async = true;

    script.onload = () => {
      if (typeof createSctxConverter !== "function") {
        reject(new Error("createSctxConverter factory not found after loading script"));
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
    };

    script.onerror = () => {
      reject(new Error("Failed to load SctxConverter.js"));
    };

    document.head.appendChild(script);
  }).catch(err => {
    wasmPromise = null;
    throw err;
  });

  return wasmPromise;
}

async function convertOne(file, wasm) {
  const id = Date.now() + "_" + Math.random().toString(16).slice(2);
  const input = "/input_" + id + ".sctx";
  const output = "/output_" + id + ".png";

  try {
    const data = new Uint8Array(await file.arrayBuffer());

    wasm.FS.writeFile(input, data);

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
      name: outputName(file.name),
      blob: new Blob([png], { type: "image/png" })
    });

  } finally {
    try { wasm.FS.unlink(input); } catch {}
    try { wasm.FS.unlink(output); } catch {}
  }
}

fileInput.addEventListener("change", () => {
  selected = [...fileInput.files].filter(f => /\.sctx$/i.test(f.name));
  results = [];
  log.innerHTML = "";
  progress.style.width = "0%";
  counter.textContent = `0 / ${selected.length}`;
  current.textContent = selected.length ? `${selected.length} file(s) selected` : "Ready";
  convertButton.disabled = selected.length === 0;
  downloadAllButton.disabled = true;
});

convertButton.addEventListener("click", async () => {
  if (!selected.length) return;

  convertButton.disabled = true;
  fileInput.disabled = true;
  results = [];
  log.innerHTML = "";

  try {
    current.textContent = "Loading decoder…";
    addLog("Loading WebAssembly decoder…", "working");

    const wasm = await loadWasm();

    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      const n = i + 1;

      counter.textContent = `${i} / ${selected.length}`;
      current.textContent = `Converting: ${file.name}`;
      addLog(`Converting: ${file.name}`, "working");

      try {
        await convertOne(file, wasm);
        addLog(`✓ ${outputName(file.name)}`, "ok");
      } catch (error) {
        console.error(error);
        addLog(`✗ ${file.name} — ${error?.message || error}`, "err");
      }

      counter.textContent = `${n} / ${selected.length}`;
      progress.style.width = `${Math.round((n / selected.length) * 100)}%`;
    }

    current.textContent = `Done — ${results.length} PNG(s)`;
    downloadAllButton.disabled = results.length === 0;

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
  for (const item of results) {
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    await new Promise(r => setTimeout(r, 150));
  }
});