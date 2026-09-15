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

  if (cls) {
    li.className = cls;
  }

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

async function loadWasm() {
  if (wasmModule) {
    return wasmModule;
  }

  if (wasmPromise) {
    return wasmPromise;
  }

  wasmPromise = (async () => {
    const url = new URL(
      "./wasm/sctx-converter.js",
      import.meta.url
    );

    const module = await import(url.href);
    const factory = module.default;

    if (typeof factory !== "function") {
      throw new Error("Invalid WebAssembly module.");
    }

    const instance = await factory({
      locateFile(filename) {
        return new URL(
          "./wasm/" + filename,
          import.meta.url
        ).href;
      }
    });

    if (
      !instance.FS ||
      typeof instance.callMain !== "function"
    ) {
      throw new Error(
        "WebAssembly runtime is missing FS or callMain."
      );
    }

    wasmModule = instance;

    return instance;
  })();

  try {
    return await wasmPromise;
  } catch (error) {
    wasmPromise = null;
    throw error;
  }
}

async function convertOne(file, wasm) {
  const id =
    Date.now() +
    "_" +
    Math.random().toString(16).slice(2);

  const input = "/input_" + id + ".sctx";
  const output = "/output_" + id + ".png";

  try {
    const data = new Uint8Array(
      await file.arrayBuffer()
    );

    wasm.FS.writeFile(input, data);

    wasm.callMain([
      "decode",
      input,
      output,
      "-t"
    ]);

    const png = wasm.FS.readFile(output);

    if (!isPng(png)) {
      throw new Error(
        "Decoder did not produce a valid PNG."
      );
    }

    results.push({
      name: outputName(file.name),
      blob: new Blob(
        [png],
        { type: "image/png" }
      )
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

fileInput.addEventListener("change", () => {
  selected = [...fileInput.files]
    .filter(file => /\.sctx$/i.test(file.name));

  results = [];
  log.innerHTML = "";

  progress.style.width = "0%";

  counter.textContent =
    `0 / ${selected.length}`;

  current.textContent = selected.length
    ? `${selected.length} file(s) selected`
    : "Ready";

  convertButton.disabled =
    selected.length === 0;

  downloadAllButton.disabled = true;
});

convertButton.addEventListener("click", async () => {
  if (!selected.length) {
    return;
  }

  convertButton.disabled = true;
  fileInput.disabled = true;

  results = [];
  log.innerHTML = "";

  try {
    current.textContent =
      "Loading decoder…";

    addLog(
      "Loading WebAssembly decoder…",
      "working"
    );

    const wasm = await loadWasm();

    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      const n = i + 1;

      counter.textContent =
        `${i} / ${selected.length}`;

      current.textContent =
        `Converting: ${file.name}`;

      addLog(
        `Converting: ${file.name}`,
        "working"
      );

      try {
        await convertOne(file, wasm);

        addLog(
          `✓ ${outputName(file.name)}`,
          "ok"
        );

      } catch (error) {
        console.error(error);

        addLog(
          `✗ ${file.name} — ${
            error?.message || error
          }`,
          "err"
        );
      }

      counter.textContent =
        `${n} / ${selected.length}`;

      progress.style.width =
        `${Math.round(
          n / selected.length * 100
        )}%`;
    }

    current.textContent =
      `Done — ${results.length} PNG(s)`;

    downloadAllButton.disabled =
      results.length === 0;

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
    for (const item of results) {
      const url =
        URL.createObjectURL(item.blob);

      const a =
        document.createElement("a");

      a.href = url;
      a.download = item.name;

      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);

      await new Promise(resolve =>
        setTimeout(resolve, 120)
      );
    }
  }
);